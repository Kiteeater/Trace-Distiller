import { parseArgv, runCli } from '../src/service/cli.ts'

const code = await runCli(parseArgv(process.argv.slice(2)))
process.exit(code)
