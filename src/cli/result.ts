/** Common CLI response contract from docs/reference/CLI.md, not an SDK return type. */
export interface Diagnostic {
  code: string;
  message: string;
  file?: string;
  line?: number;
}

export interface CommandResult<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
  errors?: Diagnostic[];
  warnings?: Diagnostic[];
}
