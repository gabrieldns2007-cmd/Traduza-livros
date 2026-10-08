import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// cada arquivo de teste usa um diretório de dados temporário e isolado
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "verso-test-"));
process.env.DEMO_DELAY_MS = "0";
