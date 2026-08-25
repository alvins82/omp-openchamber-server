export default function questionExtension(pi: any) {
  const Type = pi.typebox.Type;

  const QuestionOptionSchema = Type.Object({
    label: Type.String({ description: "Label of the selectable option" }),
    description: Type.Optional(Type.String({ description: "Description or extra context for this option" })),
  });

  const QuestionItemSchema = Type.Object({
    header: Type.Optional(Type.String({ description: "Short heading for the question category" })),
    question: Type.String({ description: "The question to ask the user" }),
    options: Type.Array(QuestionOptionSchema, { description: "List of selectable choices" }),
    multiple: Type.Optional(Type.Boolean({ description: "Allow selecting multiple choices" })),
    custom: Type.Optional(Type.Boolean({ description: "Allow custom write-in answers" })),
  });

  pi.registerTool({
    name: "question",
    label: "Ask Question",
    description:
      "Ask the user one or more interactive questions with choices to clarify requirements, select options, or gather preferences. ALWAYS use this tool whenever you want to ask the user a question with choices, options, or alternatives instead of printing markdown lists.",
    loadMode: "essential",
    approval: "read",
    parameters: Type.Object({
      questions: Type.Array(QuestionItemSchema, { description: "Questions to ask the user" }),
    }),
    async execute(_id: string, params: any, signal: any, _onUpdate: any, ctx: any) {
      if (signal?.aborted) {
        return { content: [{ type: "text", text: "Cancelled" }] };
      }

      const answers: string[] = [];
      for (const q of params.questions || []) {
        const title = q.header ? `${q.header}: ${q.question}` : q.question;
        const options = (q.options || []).map((opt: any) =>
          opt.description ? `${opt.label} - ${opt.description}` : opt.label,
        );
        const selected = await ctx.ui.select(title, options);
        if (selected) {
          answers.push(selected);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: answers.length > 0 ? answers.join("; ") : "User dismissed question",
          },
        ],
      };
    },
  });
}
