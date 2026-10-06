"use strict";

const FACEBOOK_HOST = "facebook.com";
const MESSENGER_HOST = "messenger.com";

function makeFacebookEndpoints(host) {
  const wwwHost = "www." + host;
  const baseURL = "https://" + wwwHost;
  const dgwBase = "https://gateway." + host;
  return {
    host: wwwHost,
    base_url: baseURL,
    messages: baseURL + "/messages",
    thread: baseURL + "/messages/t/",
    cookie_consent: baseURL + "/cookie/consent/",
    graphql: baseURL + "/api/graphql/",
    webgraphql: baseURL + "/webgraphql/mutation/",
    media_upload: baseURL + "/ajax/mercury/upload.php?",
    message_share_attachment: baseURL + "/message_share_attachment/fromURI/",
    send: baseURL + "/messaging/send/",
    web_push: baseURL + "/push/register/service_worker/",
    dgw_lightspeed: dgwBase + "/ws/lightspeed",
  };
}

const FacebookEndpoints = makeFacebookEndpoints(FACEBOOK_HOST);
const MessengerEndpoints = makeFacebookEndpoints(MESSENGER_HOST);
MessengerEndpoints.messages = "https://www." + MESSENGER_HOST + "/";
MessengerEndpoints.thread = "https://www." + MESSENGER_HOST + "/t/";

module.exports = { FacebookEndpoints, MessengerEndpoints };
