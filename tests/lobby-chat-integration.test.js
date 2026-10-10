'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { io } = require('socket.io-client');
const { TOS_VERSION } = require('../lib/terms');

function reservePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function waitForServer(child, output, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.off('data', onOutput);
      child.stderr.off('data', onOutput);
      child.off('exit', onExit);
      error ? reject(error) : resolve();
    };
    const onOutput = chunk => {
      output.text += chunk.toString();
      if (output.text.includes('MonteCristo lista en')) finish();
    };
    const onExit = code => finish(new Error(`El servidor terminó antes de iniciar (código ${code}).\n${output.text}`));
    const timer = setTimeout(() => finish(new Error(`Tiempo agotado esperando al servidor.\n${output.text}`)), timeoutMs);
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.on('exit', onExit);
    if (child.exitCode !== null) onExit(child.exitCode);
  });
}

function connectSocket(port) {
  const socket = io(`http://127.0.0.1:${port}`, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 5000
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Tiempo agotado conectando al chat del lobby.'));
    }, 6000);
    socket.once('connect', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('connect_error', error => {
      clearTimeout(timer);
      socket.disconnect();
      reject(error);
    });
  });
}

function emitWithAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Sin confirmación del evento ${event}.`)), 3000);
    socket.emit(event, payload, response => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

function waitForMessage(socket, predicate, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('lobby_chat_message', onMessage);
      reject(new Error('Tiempo agotado esperando el mensaje del chat.'));
    }, timeoutMs);
    const onMessage = message => {
      if (!predicate(message)) return;
      clearTimeout(timer);
      socket.off('lobby_chat_message', onMessage);
      resolve(message);
    };
    socket.on('lobby_chat_message', onMessage);
  });
}

test('el chat compartido publica la respuesta BOT, conserva sus guardas y reserva Monte', { timeout: 30000 }, async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'monte-chat-'));
  const port = await reservePort();
  const output = { text: '' };
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_URL: '',
      PROFILE_STORE_PATH: path.join(tempDir, 'profiles.json'),
      ADMIN_FEATURE_ENABLED: 'off',
      FOOTBALL_ENABLED: 'off',
      LOG_JSON: 'off'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.disconnect();
    if (child.exitCode === null && child.signalCode === null) {
      const exitedCleanly = await new Promise(resolve => {
        const timer = setTimeout(() => resolve(false), 2500);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve(true);
        });
        child.kill('SIGTERM');
      });
      if (!exitedCleanly && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise(resolve => child.once('exit', resolve));
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  await waitForServer(child, output);
  const socket = await connectSocket(port);
  sockets.push(socket);
  const token = `monte-chat-test-${Date.now()}`;
  const join = await emitWithAck(socket, 'lobby_chat_join', {
    token,
    name: 'Prueba',
    tos: TOS_VERSION
  });
  assert.equal(join.ok, true, 'el chat requiere aceptar los Términos vigentes');

  const received = [];
  socket.on('lobby_chat_message', message => received.push(message));
  const sendHumanMessage = async text => {
    const messagePromise = waitForMessage(socket, message => message.text === text && message.playerId === token);
    const ack = await emitWithAck(socket, 'lobby_chat', { text });
    assert.equal(ack.ok, true);
    return { ack, message: await messagePromise };
  };

  const ordinary = await sendHumanMessage('Hola, comunidad.');
  assert.equal(ordinary.message.bot, undefined, 'los mensajes no dirigidos no activan a Monte');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(received.some(message => message.bot), false);

  const helpHuman = waitForMessage(socket, message => message.text === '/ayuda' && message.playerId === token);
  const helpBot = waitForMessage(socket, message => message.bot === true);
  const helpAck = await emitWithAck(socket, 'lobby_chat', { text: '/ayuda' });
  assert.equal(helpAck.ok, true);
  await Promise.all([helpHuman, helpBot]);
  const assistantMessage = received.find(message => message.bot === true);
  assert.equal(assistantMessage.name, 'Monte');
  assert.equal(assistantMessage.avatar, 'robot');
  assert.equal(assistantMessage.playerId, null);
  assert.equal(assistantMessage.system, true);
  assert.match(assistantMessage.text, /asistente automático \(BOT\)/);

  const botCount = received.filter(message => message.bot).length;
  await sendHumanMessage('@Monte bots de póker');
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(received.filter(message => message.bot).length, botCount, 'el enfriamiento se aplica por perfil');

  const otherSocket = await connectSocket(port);
  sockets.push(otherSocket);
  const reserved = await emitWithAck(otherSocket, 'lobby_chat_join', {
    token: `monte-chat-reserved-${Date.now()}`,
    name: 'mOnTe',
    tos: TOS_VERSION
  });
  assert.equal(reserved.ok, false);
  assert.match(reserved.error, /reservado para el asistente BOT/);
});
