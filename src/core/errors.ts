/** An error the model can act on: what went wrong and what to do next. */
export class ToolError extends Error {
  constructor(public code: string, message: string, public next_step?: string) {
    super(message);
  }
}
