module.exports = {
	config: {
		name: "effect",
		aliases: ["effects", "pow"],
		version: "1.0",
		author: "Neoaz 🐊",
		countDown: 5,
		role: 0,
		description: {
			en: "Send a messenger effect (power-up) to a thread"
		},
		category: "media",
		guide: {
			en: "   {pn} <effect name> [text]: send the effect"
				+ "\n   {pn} <effect name> -c <count>: send the effect multiple times"
				+ "\n   {pn} <effect name> -s <subject>: send the effect with a subject"
				+ "\n   {pn} list: show the available effects"
				+ "\n   Avatar effects use the avatar_ prefix, e.g. {pn} avatar_love"
				+ "\n   Example: {pn} fire, {pn} celebration -c 3, {pn} avatar_cry"
		}
	},

	langs: {
		en: {
			list: "🎆 Available effects:\n%1\n\n🎇 Avatar effects:\n%2",
			invalidName: "❌ The effect \"%1\" does not exist, use %2 list to see the available effects.",
			error: "❌ An error occurred: %1"
		}
	},

	onStart: async function ({ api, args, message, event, getLang }) {
		const effects = api.listEffects().filter(e => e.id !== 0 && !e.aliases[0].startsWith("avatar_"));
		const avatars = api.listAvatarEffects();

		if (!args.length || args[0].toLowerCase() === "list" || args[0].toLowerCase() === "-l") {
			const effectList = effects.map(e => `  • ${e.label} (${e.aliases[0]})`).join("\n");
			const avatarList = avatars.map(a => `  • ${a.label} (avatar_${a.name})`).join("\n");
			return message.reply(getLang("list", effectList, avatarList));
		}

		const subjectIndex = args.findIndex(a => a === "-s" || a === "--subject" || a === "-u" || a === "--user");
		let subject = "";
		if (subjectIndex !== -1) {
			subject = args[subjectIndex + 1] || "";
			args = args.slice();
			args.splice(subjectIndex, 2);
		}

		let count = 1;
		const countIndex = args.findIndex(a => a === "-c" || a === "--v" || a === "-v");
		if (countIndex !== -1) {
			const parsed = parseInt(args[countIndex + 1]);
			if (!isNaN(parsed) && parsed > 0)
				count = Math.min(parsed, 20);
			args = args.slice();
			args.splice(countIndex, 2);
		}

		const name = (args.shift() || "").toLowerCase();
		const avatar = avatars.find(a => name === `avatar_${a.name}` || name === `avatar_${a.effect.toLowerCase()}`);
		const effect = effects.find(e => e.aliases.includes(name) || e.label.toLowerCase() === name);
		if (!avatar && !effect)
			return message.reply(getLang("invalidName", name, `${global.GoatBot.config.prefix}effect`));

		const label = avatar ? avatar.label : effect.label;
		const body = [subject, args.join(" ")].filter(Boolean).join(" ") || `${label}`;

		await message.reaction("⏳", event.messageID);

		try {
			for (let i = 0; i < count; i++) {
				if (avatar)
					await api.sendAvatarEffect(avatar.name, body, event.threadID);
				else
					await api.sendEffect(effect.aliases[0], body, event.threadID);
			}
			await message.reaction("✅", event.messageID);
		}
		catch (err) {
			await message.reaction("❌", event.messageID);
			return message.reply(getLang("error", err.message || JSON.stringify(err)));
		}
	}
};
