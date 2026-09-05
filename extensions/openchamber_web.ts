export default function openchamberWebExtension(pi: any) {
  const Type = pi.typebox.Type;

  const OpenChamberWebSchema = Type.Object({
    action: Type.String({
      description:
        "The browser action to perform: browser.open, browser.snapshot, browser.click, browser.type, browser.scroll, browser.resize, browser.capture, browser.inspect, browser.back, or browser.forward",
    }),
    url: Type.Optional(
      Type.String({
        description:
          "URL or local file path to open in the browser panel (for browser.open, e.g. http://localhost:3000, index.html, ./preview.html, or file:///path/to/file.html)",
      }),
    ),
    selector: Type.Optional(Type.String({ description: "CSS selector or text target (for snapshot, click, type, scroll, inspect)" })),
    text: Type.Optional(Type.String({ description: "Visible text label to match a button or link (for browser.click)" })),
    value: Type.Optional(Type.String({ description: "Text value to fill into an input field (for browser.type)" })),
    submit: Type.Optional(Type.Boolean({ description: "Whether to submit/press Enter after typing (for browser.type)" })),
    direction: Type.Optional(Type.String({ description: "Scroll direction: up, down, top, or bottom (for browser.scroll)" })),
    viewport: Type.Optional(Type.String({ description: "Viewport sizing: mobile, tablet, desktop, or fill (for browser.open, browser.resize)" })),
    label: Type.Optional(Type.String({ description: "Label prefix for captured screenshot artifact (for browser.capture)" })),
    parameters: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Optional nested parameters object" })),
  });

  pi.registerTool({
    name: "openchamber_web",
    label: "OpenChamber In-App Browser",
    description:
      "Open, view, and interact with live web pages and local HTML files inside OpenChamber's in-app browser panel. Use this to open local HTML files (e.g. index.html, file:///path/to/file.html), local dev servers (e.g. http://localhost:3000), or external URLs, read page DOM/text with browser.snapshot, click elements with browser.click, type inputs with browser.type, scroll with browser.scroll, and take screenshots with browser.capture.",
    loadMode: "essential",
    approval: "read",
    parameters: OpenChamberWebSchema,
    async execute(_id: string, params: any, signal: any, _onUpdate: any, ctx: any) {
      if (signal?.aborted) {
        return { isError: true, content: [{ type: "text", text: "Cancelled" }] };
      }

      const port = process.env.OC_SIDECAR_PORT || "4096";
      const rawAction = typeof params.action === "string" ? params.action.trim() : "";
      const action = rawAction.startsWith("browser.") ? rawAction : `browser.${rawAction}`;
      const directory = ctx?.cwd || process.cwd();

      const explicitParams = params.parameters && typeof params.parameters === "object" ? params.parameters : {};
      const flattenedParams: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(params)) {
        if (key !== "action" && key !== "parameters" && value !== undefined) {
          flattenedParams[key] = value;
        }
      }

      const mergedParams = { ...flattenedParams, ...explicitParams };

      try {
        const response = await fetch(`http://127.0.0.1:${port}/internal/browser-control/request`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action, directory, parameters: mergedParams }),
          signal,
        });

        const outcome = (await response.json()) as { ok?: boolean; data?: unknown; error?: string };

        if (!response.ok || outcome.ok === false) {
          const errorMsg = outcome.error || `Browser action ${action} failed with HTTP ${response.status}`;
          return {
            isError: true,
            content: [{ type: "text", text: errorMsg }],
          };
        }

        const data = outcome.data;
        const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);

        return {
          content: [{ type: "text", text }],
          details: data,
        };
      } catch (err: any) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: `Browser control error: ${message}` }],
        };
      }
    },
  });
}
