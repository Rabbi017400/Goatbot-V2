const os = require("os");

const AVATAR_EFFECTS = ["love", "anger", "laugh", "cry"];
const randomAvatar = () => AVATAR_EFFECTS[Math.floor(Math.random() * AVATAR_EFFECTS.length)];

const GIB = 1024 ** 3;

module.exports = {
	config: {
		name: "uptime",
		aliases: ["up", "runtime", "sysinfo"],
		version: "1.0",
		author: "Neoaz 🐊",
		countDown: 5,
		role: 0,
		description: {
			en: "Show how long the bot has been running and its system info"
		},
		category: "info",
		guide: {
			en: "   {pn}: show bot uptime and system information"
		}
	},

	onStart: async function ({ event, api, usersData, threadsData }) {
		const diff = Math.max(0, Date.now() - global.GoatBot.startTime);
		const days = Math.floor(diff / 86400000);
		const hours = Math.floor(diff / 3600000) % 24;
		const minutes = Math.floor(diff / 60000) % 60;
		const seconds = Math.floor(diff / 1000) % 60;

		const cpus = os.cpus() || [];
		const cpuModel = cpus.length ? cpus[0].model.trim() : "Unknown CPU";
		const cores = cpus.length;

		const totalMem = os.totalmem();
		const usedMem = totalMem - os.freemem();
		const totalGb = (totalMem / GIB).toFixed(1);
		const usedGb = (usedMem / GIB).toFixed(1);
		const memPercent = ((usedMem / totalMem) * 100).toFixed(1);

		const botName = global.GoatBot.config.nickNameBot || "GoatBot";
		const commandCount = global.GoatBot.commands.size;
		const userCount = (await usersData.getAll()).length;
		const threadCount = (await threadsData.getAll()).length;

		const output =
			"╭─────────────⭓\n"
			+ "│ ⏱️ UPTIME\n"
			+ "├─────⭔\n"
			+ `│ ${days}d ${hours}h ${minutes}m ${seconds}s\n`
			+ `│ Days: ${days} | Hours: ${hours}\n`
			+ `│ Minutes: ${minutes} | Seconds: ${seconds}\n`
			+ "├─────⭔\n"
			+ "│ 💻 SYSTEM\n"
			+ `│ CPU: ${cpuModel} (${cores} cores)\n`
			+ `│ RAM: ${usedGb} GB / ${totalGb} GB (${memPercent}%)\n`
			+ `│ Platform: ${os.platform()} ${os.arch()}\n`
			+ `│ Node: ${process.version}\n`
			+ "├─────⭔\n"
			+ `│ 🐑 Bot: ${botName}\n`
			+ `│ 🧩 Commands: ${commandCount}\n`
			+ `│ 👥 Users: ${userCount}\n`
			+ `│ 💬 Threads: ${threadCount}\n`
			+ "╰─────────────⭓";

		return api.sendAvatarEffect(randomAvatar(), { body: output, replyToMessageID: event.messageID }, event.threadID);
	}
};
