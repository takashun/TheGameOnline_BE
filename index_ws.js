// https://qiita.com/okumurakengo/items/c497fba7f16b41146d77
// https://www.pari.go.jp/unit/ydaku/fujita/nodejsWebSocket/

const REDIS_PORT = 6379;
const REDIS_HOST = "0.0.0.0";

// const app = require('express')()
// const server = require('http').createServer(app)

const webSocket = require('ws')
const wss = new webSocket.Server({port: 3031})

setupWsHeartbeat(wss);

const redis = require("redis");
const redisClient = redis.createClient(REDIS_PORT, REDIS_HOST)

const state = {
  ready: 0,
  progress: 1,
  preEnd: 2,
  end: 3,
}

wss.on('connection', (ws, req) => {
  const interval = setInterval(function ping() {
    console.log("heartbeat-interval")
    ws.send(JSON.stringify({func: "game-heartbeat", kind: "ping"}))
  }, 15000);

  ws.on('message',(value) => {
    const json = JSON.parse(value)

    // デバッグ
    console.dir(json)

    if(json.func == null) {
      ws.error = true
      ws.terminate()
      return
    }

    if(json.func === "game-heartbeat") {

    } else if(json.func === "join-game") {
      if(json.roomId == null || json.name == null || json.uuid == null) {
        ws.error = true
        ws.terminate()
        return
      }

      // IDを紐付け
      ws.id = json.uuid
      ws.roomId = json.roomId
      ws.error = false

      redisClient.exists(json.roomId, (err, exists) => {
        //ルームを作るか参加か
        if(exists === 0) {
          if(json.playerLimit === null) {
            ws.error = true
            ws.terminate()
          }

          let roomObject = {}
          roomObject.roomId = json.roomId
          roomObject.playerLimit = parseInt(json.playerLimit, 10);
          roomObject.players = [{id: json.uuid, name: json.name, hands: [], plays: 0}]
          roomObject.gameState = state.ready
          roomObject.gameTurnIndex = -1
          roomObject.minPlays = 2
          roomObject.deck = initDeck()
          roomObject.leads = {
            desc01: [],
            desc02: [],
            asc01: [],
            asc02: [],
          }

          redisClient.set(json.roomId, JSON.stringify(roomObject), redis.print)
          sendToPlayers("game-ready", wss.clients, roomObject.roomId, {roomObject: roomObject})
        } else if(exists === 1) {
          redisClient.get(json.roomId, (err, roomResult) => {
            let roomObject = JSON.parse(roomResult)
            if(roomObject.players.length < roomObject.playerLimit) {
              roomObject.players.push({id: json.uuid, name: json.name, hands: [], plays: 0})
              // プレイヤー数が上限に達した場合ゲーム開始
              if(roomObject.players.length < roomObject.playerLimit) {
                redisClient.set(json.roomId, JSON.stringify(roomObject), redis.print)
                sendToPlayers("game-ready", wss.clients, roomObject.roomId, {roomObject: roomObject})
              } else if(roomObject.players.length === roomObject.playerLimit) {
                roomObject.players.forEach(player => {
                  player.hands = roomObject.deck.splice(-6).sort(compareFunc)
                })
                roomObject.gameState = state.progress
                roomObject.gameTurnIndex = 0

                redisClient.set(json.roomId, JSON.stringify(roomObject), redis.print)
                sendToPlayers("game-start", wss.clients, roomObject.roomId, {roomObject: roomObject})
              }
            } else {
              ws.error = true
              ws.terminate()
            }
          })
        }
      })
    } else if(json.func === "game-progress") {
      if(json.roomObject == null || json.progType == null) {
        ws.terminate()
        return
      }

      console.log("prog")

      let roomObject = json.roomObject

      // 台札及び手札の残り枚数の計算
      let cardCount = 0
      roomObject.players.map(player => cardCount += player.hands.length)
      cardCount += roomObject.deck.length

      // 台札と手札の残り枚数に応じてクリア、完全クリアを通知
      if(cardCount <= 9 && roomObject.gameState === state.progress) {
        roomObject.gameState = state.preEnd
        sendToPlayers("game-end", wss.clients, roomObject.roomId, {endType: "preEnd"})
      } else if(cardCount === 0) {
        roomObject.gameState = state.end
        sendToPlayers("game-end", wss.clients, roomObject.roomId, {endType: "perfectEnd"})
      }

      if(json.progType === "play") {
        roomObject.players[roomObject.gameTurnIndex].plays++
        sendToPlayers("game-update", wss.clients, roomObject.roomId, {roomObject: roomObject, updateType: "update"})

        if(!canPlay(roomObject, roomObject.gameTurnIndex) && roomObject.players[roomObject.gameTurnIndex].hands.length !== 0 && roomObject.players[roomObject.gameTurnIndex].plays < roomObject.minPlays) {
          if(roomObject.gameState === state.preEnd) {
            sendToPlayers("game-end", wss.clients, roomObject.roomId, {endType: "preForcedEnd"})
          } else {
            sendToPlayers("game-end", wss.clients, roomObject.roomId, {endType: "badEnd"})
          }
          redisClient.del(roomObject.roomId)
          return
        }
      } else if(json.progType === "turn-end") {
        const nextTurnIndex =  roomObject.gameTurnIndex === roomObject.playerLimit - 1 ? 0 : roomObject.gameTurnIndex + 1

        if(roomObject.players[nextTurnIndex].hands.length === 0 || canPlay(roomObject, nextTurnIndex)) {
          roomObject.players[roomObject.gameTurnIndex].hands = roomObject.players[roomObject.gameTurnIndex].hands.concat(roomObject.deck.splice(-roomObject.players[roomObject.gameTurnIndex].plays)).sort(compareFunc)
          roomObject.players[roomObject.gameTurnIndex].plays = 0
          roomObject.gameTurnIndex = nextTurnIndex

          if(roomObject.deck.length === 0) {
            roomObject.minPlays = 1
          }

          sendToPlayers("game-update", wss.clients, roomObject.roomId, {roomObject: roomObject, updateType: "next-turn"})
        } else {
          if(roomObject.gameState === state.preEnd) {
            sendToPlayers("game-end", wss.clients, roomObject.roomId, {endType: "preForcedEnd"})
          } else {
            sendToPlayers("game-end", wss.clients, roomObject.roomId, {endType: "badEnd"})
          }
          redisClient.del(roomObject.roomId)
          return
        }
      }
      redisClient.set(roomObject.roomId, JSON.stringify(roomObject), redis.print)
    }

  ws.on('error',() => {
    console.log("error")
    clearInterval(interval)
    if(ws.roomId !== null) {
      sendToPlayers("game-error", wss.clients, ws.roomId, {msg: "参加しているプレイヤーが通信エラーのためゲームを終了します。"})
      roomPlayerTerminate(wss.clients, ws.roomId)
      redisClient.del(ws.roomId)
    }
  })

  ws.on('close',() => {
    console.log("close")
    clearInterval(interval)
    if(ws.roomId !== null && !ws.error) {
      sendToPlayers("game-error", wss.clients, ws.roomId, {msg: "他のプレイヤーが切断したためゲームを終了します。"})
      roomPlayerTerminate(wss.clients, ws.roomId)
      redisClient.del(ws.roomId)
    }
  })
  })
})

function setupWsHeartbeat(wss) {
  function noop() {}
  function heartbeat() {
    this.isAlive = true;
  }

  wss.on('connection', function connection(ws) {
    ws.isAlive = true;
    ws.on('pong', heartbeat);
  });

  const interval = setInterval(function ping() {
    wss.clients.forEach(function each(ws) {
      // client did not respond the ping (pong)
      if (ws.isAlive === false) return ws.terminate();

      ws.isAlive = false;
      ws.ping(noop);
    });
  }, 30000);
}


function canPlay(roomObject, playerIndex) {
  let canPlayCount = 0

  roomObject.players[playerIndex].hands.forEach(function(hand) {
    if(canPlayToLead(hand, roomObject.leads.desc01.slice(-1)[0], true) || canPlayToLead(hand, roomObject.leads.desc02.slice(-1)[0], true) || canPlayToLead(hand, roomObject.leads.asc01.slice(-1)[0], false) || canPlayToLead(hand, roomObject.leads.asc02.slice(-1)[0], false))
      canPlayCount++
  })

  return canPlayCount >= 1
}

function canPlayToLead(playCardNumber, leadCardNumber, order) {
  if(order) {
    if(leadCardNumber == null)
      leadCardNumber = 100
    if((leadCardNumber > playCardNumber) || (playCardNumber === leadCardNumber + 10))
      return true
  } else {
    if(leadCardNumber == null)
      leadCardNumber = 1
    if((leadCardNumber < playCardNumber) || (playCardNumber === leadCardNumber - 10))
      return true
  }
  return false
}

function sendToPlayers(func, clients, roomId, data) {
  clients.forEach((client) => {
    if(client.roomId === roomId) {
      let sendObject = {}
      Object.assign(sendObject, {func: func}, data)
      client.send(JSON.stringify(sendObject))
    }
  })
}

function roomPlayerTerminate(clients, roomId) {
  clients.forEach((client) => {
    if(client.roomId === roomId) {
      client.terminate()
    }
  })
}

function initDeck() {
  //const deck = Array.from(new Array(98)).map((v, i)=> i + 2)
  const deck = Array.from(new Array(20)).map((v,i)=> i + 2)

  for(let i = deck.length - 1; i > 0; i--){
    const r = Math.floor(Math.random() * (i + 1));
    let tmp = deck[i];
    deck[i] = deck[r];
    deck[r] = tmp;
  }

  return deck
}

function compareFunc(a, b) {
  return a - b;
}