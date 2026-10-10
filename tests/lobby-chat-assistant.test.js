'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MONTE_ASSISTANT_COOLDOWN_MS,
  getLobbyAssistantReply,
  canReplyToLobbyAssistant
} = require('../lib/lobby-chat-assistant');

test('Monte solo responde cuando se le menciona o se usa /ayuda', () => {
  assert.equal(getLobbyAssistantReply('Hola a todos'), null);
  assert.equal(getLobbyAssistantReply('¿Alguien juega poker?'), null);
  assert.equal(getLobbyAssistantReply('@montecristo hola'), null);
  assert.match(getLobbyAssistantReply('/ayuda'), /asistente automático \(BOT\)/);
  assert.match(getLobbyAssistantReply('¡Hola, @Monte!'), /asistente automático \(BOT\)/);
});

test('Monte contesta con FAQ determinista en español y sin contexto privado', () => {
  assert.match(getLobbyAssistantReply('@Monte ¿cómo creo una sala?'), /código de 5 caracteres/);
  assert.match(getLobbyAssistantReply('@MONTE como entro con codigo'), /código de 5 caracteres/);
  assert.match(getLobbyAssistantReply('@Monte ¿cómo funciona el póker?'), /all-in/);
  assert.match(getLobbyAssistantReply('@Monte reglas de blackjack'), /21/);
  assert.match(getLobbyAssistantReply('@Monte qué juegos hay'), /ruleta, dados, cara o cruz y tragamonedas/);
  assert.match(getLobbyAssistantReply('@Monte reglas generales'), /condiciones generales están en \/terminos/);
  assert.match(getLobbyAssistantReply('@Monte qué bots hay'), /niveles y estilos/);
  assert.match(getLobbyAssistantReply('@Monte mis fichas son dinero real?'), /no son dinero real/);
  assert.match(getLobbyAssistantReply('@Monte ¿qué es La Previa?'), /últimos 30 minutos/);
  assert.match(getLobbyAssistantReply('@Monte dime algo que no sabes'), /Puedo orientar sobre salas/);
});

test('el asistente aplica una pausa por perfil, no por mensaje', () => {
  const firstProfile = `assistant-cooldown-${Math.random()}`;
  const secondProfile = `assistant-cooldown-${Math.random()}`;
  const now = 1_800_000_000_000;

  assert.equal(canReplyToLobbyAssistant(firstProfile, now), true);
  assert.equal(canReplyToLobbyAssistant(firstProfile, now + MONTE_ASSISTANT_COOLDOWN_MS - 1), false);
  assert.equal(canReplyToLobbyAssistant(secondProfile, now + 1), true);
  assert.equal(canReplyToLobbyAssistant(firstProfile, now + MONTE_ASSISTANT_COOLDOWN_MS), true);
  assert.equal(canReplyToLobbyAssistant('', now), false);
});
