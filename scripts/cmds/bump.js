module.exports = {
	config: {
		name: "bump",
		aliases: ["b"],
		version: "1.0",
		author: "Neoaz 🐊",
		countDown: 5,
		role: 0,
		description: {
			en: "Bump a replied message"
		},
		category: "box chat",
		guide: {
			en: "   {pn}: reply to a message to bump it"
		}
	},

	langs: {
		en: {
			missingReply: "Reply to the message you want to bump"
		}
	},

	onStart: async function ({ event, api, getLang }) {
		if (!event.messageReply)
			return api.sendMessage(getLang("missingReply"), event.threadID);
		try {
			return await api.bumpMessage(event.messageReply.messageID, event.threadID);
		}
		catch (e) {
			return api.sendMessage(String((e && e.message) || e), event.threadID);
		}
	}
};
