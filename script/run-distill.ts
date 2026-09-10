import { parseArgv, runCli } from '../src/service/cli.ts'
import { loadLocalEnvFile } from '../src/utils/env.ts'

loadLocalEnvFile()
const code = await runCli(parseArgv(process.argv.slice(2)))
process.exit(code)
