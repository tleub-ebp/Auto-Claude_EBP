#!/usr/bin/env node
// Cross-platform port sync (Node has no python/python3 PATH dependency, unlike
// the previous sync_backend_port_to_frontend_env.py).
const fs = require("node:fs");
const path = require("node:path");

const ROOT_ENV = path.join(__dirname, "..", ".env-files", ".env");
const FRONTEND_ENV = path.join(__dirname, "..", "apps", "frontend", ".env-files", ".env");

function parseEnvFile(filePath) {
	const values = {};
	if (!fs.existsSync(filePath)) return values;
	for (const rawLine of fs.readFileSync(filePath, "utf-8").split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || !line.includes("=")) continue;
		const idx = line.indexOf("=");
		const key = line.slice(0, idx).trim();
		let value = line.slice(idx + 1).trim();
		value = value.replace(/^['"]|['"]$/g, "");
		values[key] = value;
	}
	return values;
}

const rootEnvVars = parseEnvFile(ROOT_ENV);
const backendPort = rootEnvVars.BACKEND_PORT || "9000";
const backendUrlLine = `VITE_BACKEND_URL=http://localhost:${backendPort}`;

fs.mkdirSync(path.dirname(FRONTEND_ENV), { recursive: true });

let frontendLines = [];
if (fs.existsSync(FRONTEND_ENV)) {
	frontendLines = fs.readFileSync(FRONTEND_ENV, "utf-8").split(/\r?\n/);
	if (frontendLines[frontendLines.length - 1] === "") frontendLines.pop();
}

let found = false;
for (let i = 0; i < frontendLines.length; i++) {
	if (frontendLines[i].startsWith("VITE_BACKEND_URL=")) {
		frontendLines[i] = backendUrlLine;
		found = true;
		break;
	}
}
if (!found) frontendLines.push(backendUrlLine);

fs.writeFileSync(FRONTEND_ENV, frontendLines.join("\n") + "\n");

console.log(`[sync_backend_port_to_frontend_env] VITE_BACKEND_URL synchronisé : ${backendUrlLine}`);
