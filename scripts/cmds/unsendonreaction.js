const fs = require("fs-extra");

module.exports = {
	config: {
		name: "unsendonreaction",
		aliases: ["unsendreact", "uor"],
		version: "1.0",
		author: "Neoaz 🐊",
		countDown: 5,
		role: 2,
		description: {
			en: "Turn auto-unsend on admin reaction on or off"
		},
		category: "owner",
		guide: {
			en: "   {pn} [on | off]: turn auto-unsend on admin reaction on or off (leave blank to toggle)"
		}
	},

	onStart: async function ({ message, args }) {
		const config = global.GoatBot.config;
		if (!config.customFeatures) config.customFeatures = {};
		if (!config.customFeatures.unsendOnReaction) config.customFeatures.unsendOnReaction = { reactions: ["😠", "😡"] };
		const current = config.customFeatures.unsendOnReaction.enable == true;
		const value = args[0] == "on" ? true : args[0] == "off" ? false : !current;
		config.customFeatures.unsendOnReaction.enable = value;
		fs.writeFileSync(global.client.dirConfig, JSON.stringify(config, null, 2));
		message.reply(`Auto-unsend on admin reaction is now ${value ? "on" : "off"}.`);
	}
};
