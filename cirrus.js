//-- Server side logic. Serves pixel streaming WebRTC-based page, proxies data back to Streamer --//
const express = require("express");
const os = require("os");
const cors = require("cors");
let app = express();

app.set("trust proxy", true);
app.use(express.json());
app.use(cors());

const fs = require("fs");
const path = require("path");
const querystring = require("querystring");
const bodyParser = require("body-parser");
const logging = require("./modules/logging.js");
const formatDate = require("date-fns").format;
logging.RegisterConsoleLogger();

const hostname = os.hostname();

// Command line argument --configFile needs to be checked before loading the config, all other command line arguments are dealt with through the config object
const defaultConfig = {
  UseOpenSearch: false,
  OpenSearchHost: "api-opensearch.meta.mos.ru",
  OpenSearchPort: 443,
  OpenSearchProtocol: "https",
  OpenSearchIndexName: "dev.signaling.players",
  OpenSearchEventLogsIndexName: "dev.signaling.events",
  OpenSearchLogin: "",
  OpenSearchPassword: "",
  UseFrontend: false,
  UseMatchmaker: false,
  UseHTTPS: false,
  UseAuthentication: false,
  LogToFile: true,
  LogVerbose: true,
  AdditionalRoutes: new Map(),
  MatchmakerAddress: "127.0.0.1",
  MatchmakerPort: 9999,
  MachineManagerApiAddress:
    process.env.MachineManagerApiAddress || "http://localhost:3000",
  PublicIp: "localhost",
  HttpPort: 80,
  HttpsPort: 443,
  StreamerPort: 8888,
  SFUPort: 8889,
  MaxPlayerCount: -1,
  DisableSSLCert: true,
  Realms: "meta",
  Secret_key:
    "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAjRRiFbkcrzm7Av11TDnRxWLjbjlfHutbiFdsha82269bvPQJhoWlRR5o2j8VtF9V2wfg3nBNdLuPHL7Rex9pYZ9YUHhzJqmouydXsL8WNHUTHuB14weEoY4b64P3Yzkrlt+GCsl4KD0QQbjhg9n3Yj69jqzYyVHWij0KHOXeAROxviSW/FM/7/oxz6t85GtWzT9uTtR/dQGsZIJgphKnGobi2Su93DV68P4A1D4M64+ynk59g3W8wOuTf/HTik2hIwWUVigLhuxqZjzABqmdw/+ekPm7HDSoJoOz9LKR3FU/3EquqLxo99/HjvldgwIRPBCC1f+MJyzwD5uNaL9rmQIDAQAB\n-----END PUBLIC KEY-----",
  client_id: "ue-signaling",
  MachineManagerAuthToken: process.env.MachineManagerAuthToken || null,
};

const argv = require("yargs").argv;
const configFile =
  typeof argv.configFile != "undefined"
    ? argv.configFile.toString()
    : path.join(__dirname, "config.json");

const config = require("./modules/config.js").init(configFile, defaultConfig);

if (config.LogToFile) {
  logging.RegisterFileLogger("./logs/");
}

const http = require("http").Server(app);
let https;

const OpenSearchClient = require("@opensearch-project/opensearch").Client;
const openSearchClient = new OpenSearchClient({
  node:
    config.OpenSearchProtocol +
    "://" +
    config.OpenSearchLogin +
    ":" +
    config.OpenSearchPassword +
    "@" +
    config.OpenSearchHost +
    ":" +
    config.OpenSearchPort,
  ssl: {
    rejectUnauthorized: false,
    // ca: fs.readFileSync(ca_certs_path),
    // You can turn off certificate verification (rejectUnauthorized: false) if you're using
    // self-signed certificates with a hostname mismatch.
    // cert: fs.readFileSync(client_cert_path),
    // key: fs.readFileSync(client_key_path)
  },
});

if (config.UseHTTPS) {
  //HTTPS certificate details
  const options = {
    key: fs.readFileSync(path.join(__dirname, config.HTTPSKeyFile)),
    cert: fs.readFileSync(path.join(__dirname, config.HTTPSCertFile)),
  };

  https = require("https").Server(options, app);

  if (config.UseHTTPS && config.DisableSSLCert) {
    require("https").globalAgent.options.rejectUnauthorized = false;
  }
}

const helmet = require("helmet");
const hsts = require("hsts");
const net = require("net");

let httpPort;
let httpsPort;

let FRONTEND_WEBSERVER = "https://localhost";

if (config.UseFrontend) {
  httpPort = 3000;
  httpsPort = 8000;

  if (config.UseHTTPS && config.DisableSSLCert) {
    //Required for self signed certs otherwise just get an error back when sending request to frontend see https://stackoverflow.com/a/35633993
    console.logColor(
      logging.Orange,
      "WARNING: config.DisableSSLCert is true. Unauthorized SSL certificates will be allowed! This is convenient for local testing but please DO NOT SHIP THIS IN PRODUCTION. To remove this warning please set DisableSSLCert to false in your config.json."
    );
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
  }

  const httpsClient = require("./modules/httpsClient.js");
  var webRequest = new httpsClient();
} else {
  httpPort = config.HttpPort;
  httpsPort = config.HttpsPort;
}

let streamerPort = config.StreamerPort; // port to listen to Streamer connections
let sfuPort = config.SFUPort;

let matchmakerAddress = "127.0.0.1";
let matchmakerPort = 9999;
let matchmakerRetryInterval = 5;
const matchmakerKeepAliveInterval = 1;
let maxPlayerCount = -1;

let gameSessionId;
let userSessionId;
let serverPublicIp;
let currentUser = null;

// `clientConfig` is send to Streamer and Players
// Example of STUN server setting
// let clientConfig = {peerConnectionOptions: { 'iceServers': [{'urls': ['stun:34.250.222.95:19302']}] }};
const clientConfig = { type: "config", peerConnectionOptions: {} };

// Parse public server address from command line
// --publicIp <public address>
try {
  if (typeof config.PublicIp != "undefined") {
    serverPublicIp = config.PublicIp.toString();
  }

  if (typeof config.HttpPort != "undefined") {
    httpPort = config.HttpPort;
  }

  if (typeof config.HttpsPort != "undefined") {
    httpsPort = config.HttpsPort;
  }

  if (typeof config.StreamerPort != "undefined") {
    streamerPort = config.StreamerPort;
  }

  if (typeof config.SFUPort != "undefined") {
    sfuPort = config.SFUPort;
  }

  if (typeof config.FrontendUrl != "undefined") {
    FRONTEND_WEBSERVER = config.FrontendUrl;
  }

  if (typeof config.peerConnectionOptions != "undefined") {
    clientConfig.peerConnectionOptions = JSON.parse(
      config.peerConnectionOptions
    );
    console.log(
      `peerConnectionOptions = ${JSON.stringify(
        clientConfig.peerConnectionOptions
      )}`
    );
  } else {
    console.log("No peerConnectionConfig");
  }

  if (typeof config.MatchmakerAddress != "undefined") {
    matchmakerAddress = config.MatchmakerAddress;
  }

  if (typeof config.MatchmakerPort != "undefined") {
    matchmakerPort = config.MatchmakerPort;
  }

  if (typeof config.MatchmakerRetryInterval != "undefined") {
    matchmakerRetryInterval = config.MatchmakerRetryInterval;
  }

  if (typeof config.MaxPlayerCount != "undefined") {
    maxPlayerCount = config.MaxPlayerCount;
  }
} catch (e) {
  console.error(e);
  process.exit(2);
}

if (config.UseHTTPS) {
  app.use(helmet());

  app.use(
    hsts({
      maxAge: 15552000, // 180 days in seconds
    })
  );

  //Setup http -> https redirect
  console.log("Redirecting http->https");
  app.use(function (req, res, next) {
    if (!req.secure) {
      if (req.get("Host")) {
        var hostAddressParts = req.get("Host").split(":");
        var hostAddress = hostAddressParts[0];
        if (httpsPort != 443) {
          hostAddress = `${hostAddress}:${httpsPort}`;
        }
        return res.redirect(
          ["https://", hostAddress, req.originalUrl].join("")
        );
      } else {
        console.error(
          `unable to get host name from header. Requestor ${
            req.ip
          }, url path: '${req.originalUrl}', available headers ${JSON.stringify(
            req.headers
          )}`
        );
        return res.status(400).send("Bad Request");
      }
    }
    next();
  });
}

sendGameSessionData();

// set up rate limiter: maximum of five requests per minute
const RateLimit = require("express-rate-limit");
const limiter = RateLimit({
  windowMs: 60000, // 1 minute
  max: 60,
});

// apply rate limiter to all requests
app.use(limiter);

//Setup the login page if we are using authentication
if (config.UseAuthentication) {
  // create application/x-www-form-urlencoded parser
  var urlencodedParser = bodyParser.urlencoded({ extended: false });

  //login page form data is posted here
  app.get("/login", (req, res) => {
    res.send("Login page. Please, authorize.");
  });
}

try {
  for (var property in config.AdditionalRoutes) {
    if (config.AdditionalRoutes.hasOwnProperty(property)) {
      console.log(
        `Adding additional routes "${property}" -> "${config.AdditionalRoutes[property]}"`
      );
      app.use(
        property,
        express.static(path.join(__dirname, config.AdditionalRoutes[property]))
      );
    }
  }
} catch (err) {
  console.error(`reading config.AdditionalRoutes: ${err}`);
}

app.post("/client/connect", (req, res) => {
  currentUser = {
    ...req.body,
    connectedAt: new Date().toISOString(),
  };
  sendPlayerConnectedToOpenSearch();
  sendPlayerConnectedToMatchmaker();
  res.status(200).json(currentUser);
});

app.post("/client/disconnect", (req, res) => {
  currentUser = null;
  sendPlayerDisconnectedToOpenSearch();
  sendPlayerDisconnectedToMatchmaker();
  res.status(200).json(currentUser);
});

app.get("/client", (req, res) => {
  return res.status(200).json({
    currentPlayer: currentUser || null,
  });
});

app.post("/client/event-log", async (req, res) => {
  const { messageType, action, user, payload } = req.body;

  res
    .status(200)
    .json(await sendEventLogToOpenSearch(messageType, action, user, payload));
});

http.listen(httpPort, () => {
  console.logColor(logging.Green, "Http listening on *: " + httpPort);
});

if (config.UseHTTPS) {
  https.listen(httpsPort, () => {
    console.logColor(logging.Green, "Https listening on *: " + httpsPort);
  });
}

console.logColor(
  logging.Cyan,
  `Running Cirrus - The Pixel Streaming reference implementation signalling server for Unreal Engine 5.3.`
);

let nextPlayerId = 1;

const PlayerType = { Regular: 0, SFU: 1 };

class Player {
  constructor(id, ws, type, browserSendOffer) {
    this.id = id;
    this.ws = ws;
    this.type = type;
    this.browserSendOffer = browserSendOffer;
  }

  subscribe(streamerId) {
    if (!streamers.has(streamerId)) {
      console.error(
        `subscribe: Player ${this.id} tried to subscribe to a non-existent streamer ${streamerId}`
      );
      return;
    }
    this.streamerId = streamerId;
    const msg = {
      type: "playerConnected",
      playerId: this.id,
      dataChannel: true,
      sfu: this.type == PlayerType.SFU,
      sendOffer: !this.browserSendOffer,
    };
    logOutgoing(this.streamerId, msg);
    this.sendFrom(msg);
  }

  unsubscribe() {
    if (this.streamerId && streamers.has(this.streamerId)) {
      const msg = { type: "playerDisconnected", playerId: this.id };
      logOutgoing(this.streamerId, msg);
      this.sendFrom(msg);
    }
    this.streamerId = null;
  }

  sendFrom(message) {
    if (!this.streamerId) {
      if (streamers.size > 0) {
        this.streamerId = streamers.entries().next().value[0];
        console.logColor(
          logging.Orange,
          `Player ${this.id} attempted to send an outgoing message without having subscribed first. Defaulting to ${this.streamerId}`
        );
      } else {
        console.logColor(
          logging.Orange,
          `Player ${this.id} attempted to send an outgoing message without having subscribed first. No streamer connected so this message isn't going anywhere!`
        );
        return;
      }
    }

    // normally we want to indicate what player this message came from
    // but in some instances we might already have set this (streamerDataChannels) due to poor choices
    if (!message.playerId) {
      message.playerId = this.id;
    }
    const msgString = JSON.stringify(message);

    let streamer = streamers.get(this.streamerId);
    if (!streamer) {
      console.error(
        `sendFrom: Player ${this.id} subscribed to non-existent streamer: ${this.streamerId}`
      );
    } else {
      streamer.ws.send(msgString);
    }
  }

  sendTo(message) {
    const msgString = JSON.stringify(message);
    this.ws.send(msgString);
  }
}

let streamers = new Map(); // streamerId <-> streamer socket
let players = new Map(); // playerId <-> player, where player is either a web-browser or a native webrtc player
const SFUPlayerId = "SFU";
const LegacyStreamerId = "__LEGACY__"; // old streamers that dont know how to ID will be assigned this id.

function sfuIsConnected() {
  const sfuPlayer = players.get(SFUPlayerId);
  return sfuPlayer && sfuPlayer.ws && sfuPlayer.ws.readyState == 1;
}

function getSFU() {
  return players.get(SFUPlayerId);
}

function logIncoming(sourceName, msg) {
  if (config.LogVerbose)
    console.logColor(
      logging.Blue,
      "\x1b[37m%s ->\x1b[34m %s",
      sourceName,
      JSON.stringify(msg)
    );
  else
    console.logColor(
      logging.Blue,
      "\x1b[37m%s ->\x1b[34m %s",
      sourceName,
      msg.type
    );
}

function logOutgoing(destName, msg) {
  if (config.LogVerbose)
    console.logColor(
      logging.Green,
      "\x1b[37m%s <-\x1b[32m %s",
      destName,
      JSON.stringify(msg)
    );
  else
    console.logColor(
      logging.Green,
      "\x1b[37m%s <-\x1b[32m %s",
      destName,
      msg.type
    );
}

function logForward(srcName, destName, msg) {
  if (config.LogVerbose)
    console.logColor(
      logging.Cyan,
      "\x1b[37m%s -> %s\x1b[36m %s",
      srcName,
      destName,
      JSON.stringify(msg)
    );
  else
    console.logColor(
      logging.Cyan,
      "\x1b[37m%s -> %s\x1b[36m %s",
      srcName,
      destName,
      msg.type
    );
}

let WebSocket = require("ws");
let sfuMessageHandlers = new Map();
let playerMessageHandlers = new Map();

function sanitizePlayerId(playerId) {
  if (playerId && typeof playerId === "number") {
    playerId = playerId.toString();
  }

  return playerId;
}

function getPlayerIdFromMessage(msg) {
  return sanitizePlayerId(msg.playerId);
}

function registerStreamer(id, streamer) {
  streamer.id = id;
  streamers.set(streamer.id, streamer);
}

function onStreamerDisconnected(streamer) {
  if (!streamer.id) {
    return;
  }

  if (!streamers.has(streamer.id)) {
    console.error(`Disconnecting streamer ${streamer.id} does not exist.`);
  } else {
    sendStreamerDisconnectedToMatchmaker();
    let sfuPlayer = getSFU();
    if (sfuPlayer) {
      const msg = { type: "streamerDisconnected" };
      logOutgoing(sfuPlayer.id, msg);
      sfuPlayer.sendTo(msg);
      disconnectAllPlayers(sfuPlayer.id);
    }
    disconnectAllPlayers(streamer.id);
    streamers.delete(streamer.id);
  }
}

function onStreamerMessageId(streamer, msg) {
  logIncoming(streamer.id, msg);

  let streamerId = msg.id;
  registerStreamer(streamerId, streamer);

  // subscribe any sfu to the latest connected streamer
  const sfuPlayer = getSFU();
  if (sfuPlayer) {
    sfuPlayer.subscribe(streamer.id);
  }

  // if any streamer id's assume the legacy streamer is not needed.
  streamers.delete(LegacyStreamerId);
}

function onStreamerMessagePing(streamer, msg) {
  logIncoming(streamer.id, msg);

  const pongMsg = JSON.stringify({ type: "pong", time: msg.time });
  streamer.ws.send(pongMsg);
}

function onStreamerMessageDisconnectPlayer(streamer, msg) {
  logIncoming(streamer.id, msg);

  const playerId = getPlayerIdFromMessage(msg);
  const player = players.get(playerId);
  if (player) {
    player.ws.close(1011 /* internal error */, msg.reason);
  }
}

function onStreamerMessageLayerPreference(streamer, msg) {
  let sfuPlayer = getSFU();
  if (sfuPlayer) {
    logOutgoing(sfuPlayer.id, msg);
    sfuPlayer.sendTo(msg);
  }
}

function forwardStreamerMessageToPlayer(streamer, msg) {
  const playerId = getPlayerIdFromMessage(msg);
  const player = players.get(playerId);
  if (player) {
    delete msg.playerId;
    logForward(streamer.id, playerId, msg);
    player.sendTo(msg);
  } else {
    console.warn("No playerId specified, cannot forward message: %s", msg);
  }
}

let streamerMessageHandlers = new Map();
streamerMessageHandlers.set("endpointId", onStreamerMessageId);
streamerMessageHandlers.set("ping", onStreamerMessagePing);
streamerMessageHandlers.set("offer", forwardStreamerMessageToPlayer);
streamerMessageHandlers.set("answer", forwardStreamerMessageToPlayer);
streamerMessageHandlers.set("iceCandidate", forwardStreamerMessageToPlayer);
streamerMessageHandlers.set(
  "disconnectPlayer",
  onStreamerMessageDisconnectPlayer
);
streamerMessageHandlers.set(
  "layerPreference",
  onStreamerMessageLayerPreference
);

console.logColor(
  logging.Green,
  `WebSocket listening for Streamer connections on :${streamerPort}`
);
let streamerServer = new WebSocket.Server({ port: streamerPort, backlog: 1 });
streamerServer.on("connection", function (ws, req) {
  console.logColor(
    logging.Green,
    `Streamer connected: ${req.connection.remoteAddress}`
  );
  sendStreamerConnectedToMatchmaker();

  let streamer = { ws: ws };

  ws.on("message", (msgRaw) => {
    var msg;
    try {
      msg = JSON.parse(msgRaw);
    } catch (err) {
      console.error(`Cannot parse Streamer message: ${msgRaw}\nError: ${err}`);
      ws.close(1008, "Cannot parse");
      return;
    }

    let handler = streamerMessageHandlers.get(msg.type);
    if (!handler || typeof handler != "function") {
      if (config.LogVerbose) {
        console.logColor(
          logging.White,
          "\x1b[37m-> %s\x1b[34m: %s",
          streamer.id,
          msgRaw
        );
      }
      console.error(`unsupported Streamer message type: ${msg.type}`);
      ws.close(1008, "Unsupported message type");
      return;
    }
    handler(streamer, msg);
  });

  ws.on("close", function (code, reason) {
    console.error(`streamer ${streamer.id} disconnected: ${code} - ${reason}`);
    onStreamerDisconnected(streamer);
  });

  ws.on("error", function (error) {
    console.error(`streamer ${streamer.id} connection error: ${error}`);
    onStreamerDisconnected(streamer);
    try {
      ws.close(1006 /* abnormal closure */, error);
    } catch (err) {
      console.error(`ERROR: ws.on error: ${err.message}`);
    }
  });

  ws.send(JSON.stringify(clientConfig));

  // request id
  const msg = { type: "identify" };
  logOutgoing("unknown", msg);
  ws.send(JSON.stringify(msg));

  registerStreamer(LegacyStreamerId, streamer);
});

function forwardSFUMessageToPlayer(msg) {
  const playerId = getPlayerIdFromMessage(msg);
  const player = players.get(playerId);
  if (player) {
    logForward(SFUPlayerId, playerId, msg);
    player.sendTo(msg);
  }
}

function forwardSFUMessageToStreamer(msg) {
  const sfuPlayer = getSFU();
  if (sfuPlayer) {
    logForward(SFUPlayerId, sfuPlayer.streamerId, msg);
    msg.sfuId = SFUPlayerId;
    sfuPlayer.sendFrom(msg);
  }
}

function onPeerDataChannelsSFUMessage(msg) {
  // sfu is telling a peer what stream id to use for a data channel
  const playerId = getPlayerIdFromMessage(msg);
  const player = players.get(playerId);
  if (player) {
    logForward(SFUPlayerId, playerId, msg);
    player.sendTo(msg);
    player.datachannel = true;
  }
}

function onSFUDisconnected() {
  console.log("disconnecting SFU from streamer");
  disconnectAllPlayers(SFUPlayerId);
  const sfuPlayer = getSFU();
  if (sfuPlayer) {
    sfuPlayer.unsubscribe();
    sfuPlayer.ws.close(4000, "SFU Disconnected");
  }
  players.delete(SFUPlayerId);
  streamers.delete(SFUPlayerId);
}

sfuMessageHandlers.set("offer", forwardSFUMessageToPlayer);
sfuMessageHandlers.set("answer", forwardSFUMessageToStreamer);
sfuMessageHandlers.set("streamerDataChannels", forwardSFUMessageToStreamer);
sfuMessageHandlers.set("peerDataChannels", onPeerDataChannelsSFUMessage);

console.logColor(
  logging.Green,
  `WebSocket listening for SFU connections on :${sfuPort}`
);
let sfuServer = new WebSocket.Server({ port: sfuPort });
sfuServer.on("connection", function (ws, req) {
  // reject if we already have an sfu
  if (sfuIsConnected()) {
    ws.close(1013, "Already have an SFU");
    return;
  }

  ws.on("message", (msgRaw) => {
    var msg;
    try {
      msg = JSON.parse(msgRaw);
    } catch (err) {
      console.error(`Cannot parse SFU message: ${msgRaw}\nError: ${err}`);
      ws.close(1008, "Cannot parse");
      return;
    }

    let handler = sfuMessageHandlers.get(msg.type);
    if (!handler || typeof handler != "function") {
      if (config.LogVerbose) {
        console.logColor(
          logging.White,
          "\x1b[37m-> %s\x1b[34m: %s",
          SFUPlayerId,
          msgRaw
        );
      }
      console.error(`unsupported SFU message type: ${msg.type}`);
      ws.close(1008, "Unsupported message type");
      return;
    }
    handler(msg);
  });

  ws.on("close", function (code, reason) {
    console.error(`SFU disconnected: ${code} - ${reason}`);
    onSFUDisconnected();
  });

  ws.on("error", function (error) {
    console.error(`SFU connection error: ${error}`);
    onSFUDisconnected();
    try {
      ws.close(1006 /* abnormal closure */, error);
    } catch (err) {
      console.error(`ERROR: ws.on error: ${err.message}`);
    }
  });

  let sfuPlayer = new Player(SFUPlayerId, ws, PlayerType.SFU, false);
  players.set(SFUPlayerId, sfuPlayer);
  console.logColor(
    logging.Green,
    `SFU (${req.connection.remoteAddress}) connected `
  );

  // TODO subscribe it to one of any of the streamers for now
  for (let [streamerId, streamer] of streamers) {
    sfuPlayer.subscribe(streamerId);
    break;
  }

  // sfu also acts as a streamer
  registerStreamer(SFUPlayerId, { ws: ws });
});

let playerCount = 0;

function sendPlayersCount() {
  const msg = { type: "playerCount", count: players.size };
  logOutgoing("[players]", msg);
  for (let player of players.values()) {
    player.sendTo(msg);
  }
}

function onPlayerMessageSubscribe(player, msg) {
  logIncoming(player.id, msg);
  player.subscribe(msg.streamerId);
}

function onPlayerMessageUnsubscribe(player, msg) {
  logIncoming(player.id, msg);
  player.unsubscribe();
}

function onPlayerMessageStats(player, msg) {
  console.log(`player ${playerId}: stats\n${msg.data}`);
}

function onPlayerMessageListStreamers(player, msg) {
  logIncoming(player.id, msg);

  let reply = { type: "streamerList", ids: [] };
  for (let [streamerId, streamer] of streamers) {
    reply.ids.push(streamerId);
  }

  logOutgoing(player.id, reply);
  player.sendTo(reply);
}

function forwardPlayerMessage(player, msg) {
  logForward(player.id, player.streamerId, msg);
  player.sendFrom(msg);
}

function onPlayerDisconnected(playerId) {
  const player = players.get(playerId);
  player.unsubscribe();
  players.delete(playerId);
  --playerCount;
  sendPlayersCount();
  sendPlayerDisconnectedToFrontend();
  sendPlayerDisconnectedToMatchmaker();
  sendHttpMessageToMachineManager({
    type: "clientDisconnected",
    hostname,
  });
  sendPlayerDisconnectedToOpenSearch();
  currentUser = null;
}

playerMessageHandlers.set("subscribe", onPlayerMessageSubscribe);
playerMessageHandlers.set("unsubscribe", onPlayerMessageUnsubscribe);
playerMessageHandlers.set("stats", onPlayerMessageStats);
playerMessageHandlers.set("offer", forwardPlayerMessage);
playerMessageHandlers.set("answer", forwardPlayerMessage);
playerMessageHandlers.set("iceCandidate", forwardPlayerMessage);
playerMessageHandlers.set("listStreamers", onPlayerMessageListStreamers);
// sfu related messages
playerMessageHandlers.set("dataChannelRequest", forwardPlayerMessage);
playerMessageHandlers.set("peerDataChannelsReady", forwardPlayerMessage);

console.logColor(
  logging.Green,
  `WebSocket listening for Players connections on :${httpPort}`
);
let playerServer = new WebSocket.Server({
  server: config.UseHTTPS ? https : http,
});
playerServer.on("connection", function (ws, req) {
  var url = require("url");
  const parsedUrl = url.parse(req.url);
  const urlParams = new URLSearchParams(parsedUrl.search);
  const browserSendOffer =
    urlParams.has("OfferToReceive") &&
    urlParams.get("OfferToReceive") !== "false";

  if (playerCount + 1 > maxPlayerCount && maxPlayerCount !== -1) {
    console.logColor(
      logging.Red,
      `new connection would exceed number of allowed concurrent connections. Max: ${maxPlayerCount}, Current ${playerCount}`
    );
    ws.close(
      1013,
      `too many connections. max: ${maxPlayerCount}, current: ${playerCount}`
    );
    return;
  }

  ++playerCount;
  let playerId = sanitizePlayerId(nextPlayerId++);
  console.logColor(
    logging.Green,
    `player ${playerId} (${req.connection.remoteAddress}) connected`
  );
  let player = new Player(playerId, ws, PlayerType.Regular, browserSendOffer);
  players.set(playerId, player);

  ws.on("message", (msgRaw) => {
    var msg;
    try {
      msg = JSON.parse(msgRaw);
    } catch (err) {
      console.error(
        `Cannot parse player ${playerId} message: ${msgRaw}\nError: ${err}`
      );
      ws.close(1008, "Cannot parse");
      return;
    }

    let player = players.get(playerId);
    if (!player) {
      console.error(
        `Received a message from a player not in the player list ${playerId}`
      );
      ws.close(1001, "Broken");
      return;
    }

    let handler = playerMessageHandlers.get(msg.type);
    if (!handler || typeof handler != "function") {
      if (config.LogVerbose) {
        console.logColor(
          logging.White,
          "\x1b[37m-> %s\x1b[34m: %s",
          playerId,
          msgRaw
        );
      }
      console.error(`unsupported player message type: ${msg.type}`);
      ws.close(1008, "Unsupported message type");
      return;
    }
    handler(player, msg);
  });

  ws.on("close", function (code, reason) {
    console.logColor(
      logging.Yellow,
      `player ${playerId} connection closed: ${code} - ${reason}`
    );
    onPlayerDisconnected(playerId);
  });

  ws.on("error", function (error) {
    console.error(`player ${playerId} connection error: ${error}`);
    ws.close(1006 /* abnormal closure */, error);
    onPlayerDisconnected(playerId);

    console.logColor(logging.Red, `Trying to reconnect...`);
    reconnect();
  });

  sendPlayerConnectedToFrontend();
  sendPlayerConnectedToMatchmaker();
  player.ws.send(JSON.stringify(clientConfig));
  sendPlayersCount();

  sendHttpMessageToMachineManager({
    type: "clientConnected",
    hostname,
  });
});

function disconnectAllPlayers(streamerId) {
  console.log(`unsubscribing all players on ${streamerId}`);
  let clone = new Map(players);
  for (let player of clone.values()) {
    if (player.streamerId == streamerId) {
      // disconnect players but just unsubscribe the SFU
      if (player.id == SFUPlayerId) {
        // because we're working on a clone here we have to access directly
        getSFU().unsubscribe();
      } else {
        player.ws.close();
      }
    }
  }
}

/**
 * Function that handles the connection to the matchmaker.
 */

if (config.UseMatchmaker) {
  var matchmaker = new net.Socket();

  matchmaker.on("connect", function () {
    console.log(
      `Cirrus connected to Matchmaker ${matchmakerAddress}:${matchmakerPort}`
    );

    // message.playerConnected is a new variable sent from the SS to help track whether or not a player
    // is already connected when a 'connect' message is sent (i.e., reconnect). This happens when the MM
    // and the SS get disconnected unexpectedly (was happening often at scale for some reason).
    var playerConnected = false;

    // Set the playerConnected flag to tell the MM if there is already a player active (i.e., don't send a new one here)
    if (players && players.size > 0) {
      playerConnected = true;
    }

    // Add the new playerConnected flag to the message body to the MM
    message = {
      type: "connect",
      address:
        typeof serverPublicIp === "undefined" ? "127.0.0.1" : serverPublicIp,
      port: config.UseHTTPS ? httpsPort : httpPort,
      ready: streamers.size > 0,
      playerConnected: playerConnected,
      hostname,
      currentPlayer: currentUser,
    };

    matchmaker.write(JSON.stringify(message));
  });

  matchmaker.on("error", (err) => {
    console.log(`Matchmaker connection error ${JSON.stringify(err)}`);
  });

  matchmaker.on("end", () => {
    console.log("Matchmaker connection ended");
  });

  matchmaker.on("close", (hadError) => {
    console.logColor(logging.Blue, "Setting Keep Alive to true");
    matchmaker.setKeepAlive(true, 60000); // Keeps it alive for 60 seconds

    console.log(`Matchmaker connection closed (hadError=${hadError})`);

    reconnect();
  });

  // Attempt to connect to the Matchmaker
  function connect() {
    matchmaker.connect(matchmakerPort, matchmakerAddress);
  }

  // Try to reconnect to the Matchmaker after a given period of time
  function reconnect() {
    console.log(
      `Try reconnect to Matchmaker in ${matchmakerRetryInterval} seconds`
    );
    setTimeout(function () {
      connect();
    }, matchmakerRetryInterval * 1000);
  }

  function registerMMKeepAlive() {
    setInterval(function () {
      message = {
        type: "ping",
      };
      matchmaker.write(JSON.stringify(message));
    }, matchmakerKeepAliveInterval * 1000);
  }

  connect();
  registerMMKeepAlive();
}

//Keep trying to send gameSessionId in case the server isn't ready yet
function sendGameSessionData() {
  //If we are not using the frontend web server don't try and make requests to it
  if (!config.UseFrontend) return;

  webRequest.get(
    `${FRONTEND_WEBSERVER}/server/requestSessionId`,
    function (response, body) {
      if (response.statusCode === 200) {
        gameSessionId = body;
        console.log("SessionId: " + gameSessionId);
      } else {
        console.error("Status code: " + response.statusCode);
        console.error(body);
      }
    },
    function (err) {
      //Repeatedly try in cases where the connection timed out or never connected
      if (err.code === "ECONNRESET") {
        //timeout
        sendGameSessionData();
      } else if (err.code === "ECONNREFUSED") {
        console.error(
          "Frontend server not running, unable to setup game session"
        );
      } else {
        console.error(err);
      }
    }
  );
}

function sendUserSessionData(serverPort) {
  //If we are not using the frontend web server don't try and make requests to it
  if (!config.UseFrontend) return;
  webRequest.get(
    `${FRONTEND_WEBSERVER}/server/requestUserSessionId?gameSessionId=${gameSessionId}&serverPort=${serverPort}&appName=${querystring.escape(
      clientConfig.AppName
    )}&appDescription=${querystring.escape(clientConfig.AppDescription)}${
      typeof serverPublicIp === "undefined"
        ? ""
        : "&serverHost=" + serverPublicIp
    }`,
    function (response, body) {
      if (response.statusCode === 410) {
        sendUserSessionData(serverPort);
      } else if (response.statusCode === 200) {
        userSessionId = body;
        console.log("UserSessionId: " + userSessionId);
      } else {
        console.error("Status code: " + response.statusCode);
        console.error(body);
      }
    },
    function (err) {
      //Repeatedly try in cases where the connection timed out or never connected
      if (err.code === "ECONNRESET") {
        //timeout
        sendUserSessionData(serverPort);
      } else if (err.code === "ECONNREFUSED") {
        console.error(
          "Frontend server not running, unable to setup user session"
        );
      } else {
        console.error(err);
      }
    }
  );
}

function sendServerDisconnect() {
  //If we are not using the frontend web server don't try and make requests to it
  if (!config.UseFrontend) return;
  try {
    webRequest.get(
      `${FRONTEND_WEBSERVER}/server/serverDisconnected?gameSessionId=${gameSessionId}&appName=${querystring.escape(
        clientConfig.AppName
      )}`,
      function (response, body) {
        if (response.statusCode === 200) {
          console.log("serverDisconnected acknowledged by Frontend");
        } else {
          console.error("Status code: " + response.statusCode);
          console.error(body);
        }
      },
      function (err) {
        //Repeatedly try in cases where the connection timed out or never connected
        if (err.code === "ECONNRESET") {
          //timeout
          sendServerDisconnect();
        } else if (err.code === "ECONNREFUSED") {
          console.error(
            "Frontend server not running, unable to setup user session"
          );
        } else {
          console.error(err);
        }
      }
    );
  } catch (err) {
    console.logColor(
      logging.Red,
      `ERROR::: sendServerDisconnect error: ${err.message}`
    );
  }
}

function sendPlayerConnectedToFrontend() {
  //If we are not using the frontend web server don't try and make requests to it
  if (!config.UseFrontend) return;
  try {
    webRequest.get(
      `${FRONTEND_WEBSERVER}/server/clientConnected?gameSessionId=${gameSessionId}&appName=${querystring.escape(
        clientConfig.AppName
      )}`,
      function (response, body) {
        if (response.statusCode === 200) {
          console.log("clientConnected acknowledged by Frontend");
        } else {
          console.error("Status code: " + response.statusCode);
          console.error(body);
        }
      },
      function (err) {
        //Repeatedly try in cases where the connection timed out or never connected
        if (err.code === "ECONNRESET") {
          //timeout
          sendPlayerConnectedToFrontend();
        } else if (err.code === "ECONNREFUSED") {
          console.error(
            "Frontend server not running, unable to setup game session"
          );
        } else {
          console.error(err);
        }
      }
    );
  } catch (err) {
    console.logColor(
      logging.Red,
      `ERROR::: sendPlayerConnectedToFrontend error: ${err.message}`
    );
  }
}

function sendPlayerDisconnectedToFrontend() {
  //If we are not using the frontend web server don't try and make requests to it
  if (!config.UseFrontend) return;
  try {
    webRequest.get(
      `${FRONTEND_WEBSERVER}/server/clientDisconnected?gameSessionId=${gameSessionId}&appName=${querystring.escape(
        clientConfig.AppName
      )}`,
      function (response, body) {
        if (response.statusCode === 200) {
          console.log("clientDisconnected acknowledged by Frontend");
        } else {
          console.error("Status code: " + response.statusCode);
          console.error(body);
        }
      },
      function (err) {
        //Repeatedly try in cases where the connection timed out or never connected
        if (err.code === "ECONNRESET") {
          //timeout
          sendPlayerDisconnectedToFrontend();
        } else if (err.code === "ECONNREFUSED") {
          console.error(
            "Frontend server not running, unable to setup game session"
          );
        } else {
          console.error(err);
        }
      }
    );
  } catch (err) {
    console.logColor(
      logging.Red,
      `ERROR::: sendPlayerDisconnectedToFrontend error: ${err.message}`
    );
  }
}

function sendStreamerConnectedToMatchmaker() {
  if (!config.UseMatchmaker) return;

  try {
    message = { type: "streamerConnected" };
    matchmaker.write(JSON.stringify(message));
  } catch (err) {
    console.logColor(
      logging.Red,
      `ERROR sending streamerConnected: ${err.message}`
    );
  }
}

function sendStreamerDisconnectedToMatchmaker() {
  if (!config.UseMatchmaker) return;

  try {
    message = { type: "streamerDisconnected" };
    matchmaker.write(JSON.stringify(message));
  } catch (err) {
    console.logColor(
      logging.Red,
      `ERROR sending streamerDisconnected: ${err.message}`
    );
  }
}

// The Matchmaker will not re-direct clients to this Cirrus server if any client is connected.
async function sendPlayerConnectedToMatchmaker() {
  if (!config.UseMatchmaker) return;
  try {
    message = { type: "clientConnected", currentPlayer: currentUser, hostname };
    matchmaker.write(JSON.stringify(message));
  } catch (err) {
    console.logColor(
      logging.Red,
      `ERROR sending clientConnected: ${err.message}`
    );
  }
}

// The Matchmaker is interested when nobody is connected to a Cirrus server
// because then it can re-direct clients to this re-cycled Cirrus server.
async function sendPlayerDisconnectedToMatchmaker() {
  if (!config.UseMatchmaker) return;

  try {
    message = { type: "clientDisconnected", currentPlayer: null, hostname };
    matchmaker.write(JSON.stringify(message));
  } catch (err) {
    console.logColor(
      logging.Red,
      `ERROR sending clientDisconnected: ${err.message}`
    );
  }
}

function createOpenSearchPlayerMessage(type) {
  if (!currentUser) return false;

  const { accountName, displayName, mail } = currentUser;

  return {
    signaling: config.PublicIp,
    type,
    accountName,
    displayName,
    mail,
    environment: config.OpenSearchIndexName.split(".")[0],
    datetime: new Date().toISOString(),
  };
}

async function sendPlayerDisconnectedToOpenSearch() {
  if (!config.UseOpenSearch) return;

  try {
    const message = createOpenSearchPlayerMessage("playerDisconnected");

    if (message) {
      await openSearchClient.index({
        index: createIndexName("OpenSearchIndexName"),
        body: message,
        refresh: true,
      });
    }
  } catch (error) {
    console.log(error);
  }
}

async function sendPlayerConnectedToOpenSearch() {
  if (!config.UseOpenSearch) return;

  try {
    const message = createOpenSearchPlayerMessage("playerConnected");

    if (message) {
      await openSearchClient.index({
        index: createIndexName("OpenSearchIndexName"),
        body: message,
        refresh: true,
      });
    }
  } catch (error) {
    console.log(error);
  }
}

async function sendEventLogToOpenSearch(messageType, action, user, payload) {
  if (!config.UseOpenSearch) return;

  try {
    const message = {
      type: messageType,
      action,
      accountName: user?.accountName,
      accountEmail: user?.mail,
      accountDisplayName: user?.displayName,
      payload,
      environment: config.OpenSearchEventLogsIndexName.split(".")[0],
      datetime: new Date().toISOString(),
    };

    if (message) {
      return await openSearchClient.index({
        index: createIndexName("OpenSearchEventLogsIndexName"),
        body: message,
        refresh: true,
      });
    }
  } catch (error) {
    console.log(error);
    return error;
  }
}

const sendHttpMessageToMachineManager = async (data) => {
  try {
    const response = await fetch(config.MachineManagerApiAddress, {
      method: "POST",
      body: JSON.stringify(data),
      headers: {
        "Content-Type": "application/json;charset=utf-8",
        Token: config.MachineManagerAuthToken,
      },
    }).then((res) => res.json());

    if (response?.success) {
      console.logColor(
        logging.Green,
        `NOTIFY TO MM: message ${data.type} SUCCESS`
      );
    } else {
      console.logColor(
        logging.Orange,
        `NOTIFY TO MM: message ${data.type} FAILED`
      );
    }
  } catch (error) {
    console.log(error);
    return error;
  }
};

function createIndexName(indexKey) {
  return config[indexKey] + "-" + formatDate(new Date(), "yyyy.MM.dd");
}
