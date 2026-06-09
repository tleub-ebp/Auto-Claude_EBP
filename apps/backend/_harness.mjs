import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const py = join(resolve(__dirname, "../../.venv"), "Scripts", "python.exe");
const args = ["-m","uvicorn","provider_api:app","--host","127.0.0.1","--port","9013","--reload","--reload-dir",__dirname];
const p = spawn(py, args, { stdio: "inherit", cwd: __dirname });
setTimeout(() => { p.kill(); process.exit(0); }, 10000);
