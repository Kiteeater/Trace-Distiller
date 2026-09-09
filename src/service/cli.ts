export interface CliArgs {
  command: 'distill' | 'eval' | 'report'
  input_path: string
  profile_path?: string
  sqlite_path?: string
  out_dir?: string
  report_path?: string
  no_llm?: boolean
}

export function parseArgv(_argv: string[]): CliArgs {
  throw new Error('not implemented')
}

export function runCli(_args: CliArgs): Promise<number> {
  throw new Error('not implemented')
}
