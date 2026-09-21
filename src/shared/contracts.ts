/**
 * Protocol value types shared by the HTTP adapters and provider runtimes.
 *
 * These types intentionally contain no adapter state or transport behavior.
 */

export interface QuestionOption {
  label: string;
  description?: string;
}

export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

export interface BrowserControlRequest {
  requestId: string;
  action: string;
  parameters: Record<string, unknown>;
  directory?: string;
}
