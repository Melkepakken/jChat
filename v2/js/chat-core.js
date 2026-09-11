(function ($) {
  // Thanks to BrunoLM (https://stackoverflow.com/a/3855394)
  $.QueryString = (function (paramsArray) {
    let params = {};

    for (let i = 0; i < paramsArray.length; ++i) {
      let param = paramsArray[i].split("=", 2);

      if (param.length !== 2) continue;

      try {
        params[param[0]] = decodeURIComponent(param[1].replace(/\+/g, " "));
      } catch (err) {
        // Ignore malformed query values without preventing other sources starting.
      }
    }

    return params;
  })(window.location.search.substr(1).split("&"));
})(jQuery);

window.Chat = window.Chat || {};
Chat.version = "1.3.1";
console.log("jChat+ v" + Chat.version);

Chat.getPlatformBadgeMode = function (value, provided) {
  if (!provided) return "on";
  if (/^only$/i.test(value)) return "only";

  return /^(1|true|yes)$/i.test(value) ? "on" : "off";
};

$.extend(true, Chat, {
  info: {
    channel: null,
    channelID: null,
    platforms: null,
    showGifs: false,
    gifSize: "medium",
    startupGeneration: 0,
    preview:
      "preview" in $.QueryString
        ? /^(1|true|yes)$/i.test($.QueryString.preview)
        : false,
    previewTimer: null,
    previewSeedTimer: null,
    previewIndex: 0,
    previewLastMessageKey: null,
    previewMinDelay: 220,
    previewMaxDelay: 1200,
    previewBurstChance: 0.22,
    previewPauseChance: 0.07,
    kickRoomId: false,
    kickChannel: false,
    kickPusherUrl:
      "wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0-rc2&flash=false",
    kickSocket: null,
    kickReconnectTimer: null,
    kickReconnectAttempts: 0,
    kickReconnectBaseDelay: 1000,
    kickReconnectMaxDelay: 30000,
    kickManualClose: false,
    animate:
      "animate" in $.QueryString
        ? $.QueryString.animate.toLowerCase() === "true"
        : false,
    showBots:
      "bots" in $.QueryString
        ? $.QueryString.bots.toLowerCase() === "true"
        : false,
    hideCommands:
      "hide_commands" in $.QueryString
        ? $.QueryString.hide_commands.toLowerCase() === "true"
        : false,
    hideBadges:
      "hide_badges" in $.QueryString
        ? $.QueryString.hide_badges.toLowerCase() === "true"
        : false,
    hideAllBadges: "hide_all_badges" in $.QueryString,
    platformBadges: Chat.getPlatformBadgeMode(
      $.QueryString.platform_badges,
      "platform_badges" in $.QueryString,
    ),
    nicknameColor: "cN" in $.QueryString ? $.QueryString.cN : false,
    emojiStyle:
      "emoji" in $.QueryString && $.QueryString.emoji.toLowerCase() === "native"
        ? "native"
        : "twemoji",
    ffzRoomBadges:
      "ffz_room_badges" in $.QueryString
        ? $.QueryString.ffz_room_badges.toLowerCase() === "true"
        : false,
    ffzUserBadges:
      "ffz_user_badges" in $.QueryString
        ? /^(1|true|yes)$/i.test($.QueryString.ffz_user_badges)
        : false,

    ffzUserBadgeCache: {},
    ffzUserBadgeRequest: null,
    ffzUserBadgeWarningShown: false,
    fade: "fade" in $.QueryString ? parseInt($.QueryString.fade) : false,
    size: "size" in $.QueryString ? parseInt($.QueryString.size) : 3,
    font: "font" in $.QueryString ? parseInt($.QueryString.font) : 0,
    stroke: "stroke" in $.QueryString ? parseInt($.QueryString.stroke) : false,
    shadow: "shadow" in $.QueryString ? parseInt($.QueryString.shadow) : false,
    messageBox:
      "message_box" in $.QueryString
        ? /^(1|true|yes)$/i.test($.QueryString.message_box)
        : false,
    emoteShadow:
      "emote_shadow" in $.QueryString
        ? /^(1|true|yes)$/i.test($.QueryString.emote_shadow)
        : false,
    smallCaps:
      "small_caps" in $.QueryString
        ? $.QueryString.small_caps.toLowerCase() === "true"
        : false,
    emotes: {},
    kickEmotes: {},
    badges: {},
    kickBadges: {},
    kickSubscriberBadges: {},
    userBadges: {},
    ffzapBadges: null,
    bttvBadges: null,
    seventvBadges: null,
    seventvBadgeCache: {},
    seventvPaintCache: {},
    seventvBadgeRequests: {},
    seventvBadgeQueue: [],
    seventvBadgeActiveRequests: 0,
    seventvBadgeRequestLimit: 3,
    seventvBadgeQueueLimit: 100,
    seventvBadgeWarnings: {},
    seventvNamePaints:
      "seventv_paints" in $.QueryString
        ? /^(1|true|yes)$/i.test($.QueryString.seventv_paints)
        : false,
    chatterinoBadges: null,
    cheers: {},
    lines: [],
    deletedMessages: {},
    blockedUsers:
      "block" in $.QueryString
        ? $.QueryString.block.toLowerCase().split(",")
        : false,
    bots: Array.isArray(window.jChatPlusBots) ? window.jChatPlusBots : [],
  },

  isPlatformEnabled: function (platform) {
    var settings = Chat.info.platforms && Chat.info.platforms[platform];
    return Boolean(settings && (Chat.info.preview ? settings.selected : settings.enabled));
  },

  applyPlatformSettings: function (query) {
    var settings = window.jChatPlatformSettings.parse(query);
    var previous = Chat.info.platforms;
    if (!previous || ["twitch", "kick", "youtube"].some(function (platform) {
      return JSON.stringify(previous[platform]) !== JSON.stringify(settings[platform]);
    })) {
      Chat.info.startupGeneration++;
    }
    Chat.info.platforms = settings;
    Chat.info.channel = settings.twitch.channel;
    Chat.info.kickChannel = settings.kick.channel || false;
    Chat.info.kickRoomId = settings.kick.roomId || false;
    // Feed resolved configuration into the existing YouTube state machine.
    Chat.info.youtubeOption = window.jChatPlatformSettings.formatYouTubeHandle(settings.youtube.handle) || false;
    Chat.info.youtubeDisabled = settings.youtube.disabled || !settings.youtube.enabled;
    Chat.info.youtubeDirectVideoId = settings.youtube.videoId;
    Chat.info.youtubeDirectVideoPending = Boolean(settings.youtube.videoId);
    Chat.info.showGifs = settings.showGifs && Chat.isPlatformEnabled("twitch");
    Chat.info.gifSize = settings.gifSize;
    return settings;
  },

  normalizeBlockedUsers: function (value) {
    if (!value) {
      return false;
    }

    var users = String(value)
      .toLowerCase()
      .split(",")
      .map(function (user) {
        return user.trim();
      })
      .filter(Boolean);

    return users.length ? users : false;
  },

  isUserBlocked: function (value) {
    if (!Chat.info.blockedUsers || !value) {
      return false;
    }

    return Chat.info.blockedUsers.includes(String(value).toLowerCase());
  },
});
