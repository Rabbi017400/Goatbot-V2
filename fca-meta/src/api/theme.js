"use strict";

const { threadColorTask } = require("../tasks");

const AI_THEME_QUERY = "useGenerateAIThemeMutation";

function normalizeTheme(theme) {
  if (!theme || typeof theme !== "object") return null;
  const asset = theme.background_asset || {};
  const image = asset.image || {};
  return {
    id: String(theme.id || ""),
    accessibilityLabel: theme.accessibility_label || null,
    description: theme.description || null,
    backgroundAssetID: asset.id ? String(asset.id) : null,
    backgroundImage: image.uri || null,
    composerBackgroundColor: theme.composer_background_color || null,
    composerTintColor: theme.composer_tint_color || null,
    titleBarTextColor: theme.title_bar_text_color || null,
    titleBarButtonTintColor: theme.title_bar_button_tint_color || null,
    backgroundGradientColors: theme.background_gradient_colors || [],
    inboundMessageGradientColors: theme.inbound_message_gradient_colors || [],
    raw: theme,
  };
}

async function createAITheme(client, prompt) {
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new Error("createAITheme: prompt must be a non-empty string");
  }
  const text = prompt.trim();
  let response;
  let payload;
  let themes = [];
  for (let attempt = 0; attempt < 2; attempt++) {
    response = await client.makeGraphQLRequest(AI_THEME_QUERY, {
      input: {
        client_mutation_id: String(Math.floor(Math.random() * 1e15)),
        actor_id: client.getCurrentUserID(),
        bypass_cache: true,
        caller: "MESSENGER",
        num_themes: 1,
        prompt: text,
      },
    });
    if (response && response.errors && response.errors.length) {
      const err = new Error("createAITheme: theme generation failed");
      err.res = response;
      throw err;
    }
    payload = response && response.data && response.data.xfb_generate_ai_themes_from_prompt;
    themes = (payload && payload.themes) || [];
    if (themes.length) break;
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  if (!themes.length) {
    const err = new Error("createAITheme: no themes generated (the AI theme service may be rate limited; retry shortly)");
    err.res = response;
    throw err;
  }
  const theme = normalizeTheme(themes[0]);
  if (!theme || !theme.id) {
    const err = new Error("createAITheme: invalid theme data");
    err.res = response;
    throw err;
  }
  return theme;
}

function extractThemeResponse(response) {
  const payload = response && response.payload;
  const step = Array.isArray(payload) ? payload : payload && payload.step;
  try {
    const candidate = step && step[1] && step[1][2] && step[1][2][2] && step[1][2][2][1];
    const messageID = candidate && candidate[2];
    const body = candidate && candidate[4];
    if (messageID && body) return { body: String(body), messageID: String(messageID) };
  } catch (_) { /* fall through */ }
  return { success: true };
}

async function setThreadTheme(client, threadID, themeID) {
  if (threadID === undefined || threadID === null || threadID === "") {
    throw new Error("setThreadTheme: threadID is required");
  }
  if (themeID === undefined || themeID === null || themeID === "" || !/^\d+$/.test(String(themeID))) {
    throw new Error("setThreadTheme: themeID must be a numeric theme id");
  }
  const response = await client.sendTasks([threadColorTask(Number(threadID), String(themeID))]);
  return extractThemeResponse(response);
}

async function changeTheme(client, prompt, threadID) {
  const theme = await createAITheme(client, prompt);
  const applied = await setThreadTheme(client, threadID, theme.id);
  return Object.assign({ themeID: theme.id, theme }, applied);
}

module.exports = {
  createAITheme,
  setThreadTheme,
  changeTheme,
  normalizeTheme,
  AI_THEME_QUERY,
};
