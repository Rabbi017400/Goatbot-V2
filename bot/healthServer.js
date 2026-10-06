/**
 * Render and most PaaS run the bot as a web service and require the process to
 * bind a port. The bot's own servers (dashboard / serverUptime) only bind when
 * explicitly enabled, so this lightweight health server keeps the port open on
 * PORT when nothing else will bind. Skipped on Replit/Glitch, which supply
 * their own web server.
 */
const http = require("http");

function shouldStart(config) {
	return Boolean(
		process.env.PORT
		&& !config?.dashBoard?.enable
		&& !config?.serverUptime?.enable
		&& !process.env.REPL_OWNER
		&& !process.env.REPL_ID
		&& process.env.API_SERVER_EXTERNAL != "https://api.glitch.com"
	);
}

function startHealthServer(config, log) {
	if (!shouldStart(config))
		return null;

	const port = Number(process.env.PORT);
	const server = http.createServer((req, res) => {
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("OK");
	});
	server.on("error", (err) => {
		log?.warn("HEALTH", `Can't start health server on port ${port}: ${err.message}`);
	});
	server.listen(port, () => {
		log?.info("HEALTH", `Health server listening on port ${port}`);
	});
	return server;
}

module.exports = { startHealthServer, shouldStart };
