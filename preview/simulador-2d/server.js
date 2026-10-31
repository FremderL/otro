'use strict';

// Vista de prueba aislada: no arranca el scheduler, los sockets ni los stores.
const path = require('path');
const express = require('express');
const { publicTeams } = require('../../lib/football/sockets');
const app = express();
const root = path.resolve(__dirname, '../..');
app.get('/api/estadio/state', (_req, res) => res.json({ ok: true, standalonePreview: true, teams: publicTeams() }));
app.get('/estadio-simulador/motor.js', (_req, res) => res.sendFile(path.join(root, 'lib/football/v2/simulator.js')));
app.get(['/', '/estadio-simulador'], (_req, res) => res.sendFile(path.join(root, 'public/estadio-simulador.html')));
app.use(express.static(path.join(root, 'public')));
const port = Number(process.env.PORT) || 3001;
app.listen(port, '0.0.0.0', () => console.log(`Simulador de prueba disponible en el puerto ${port}`));
