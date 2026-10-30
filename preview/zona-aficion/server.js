'use strict';
// Servidor local de la demostración: no monta el backend ni modifica datos.
const path = require('path');
const express = require('express');
const app = express();
app.use('/assets', express.static(path.join(__dirname, '..', '..', 'public', 'assets')));
app.use(express.static(__dirname));
const port = Number(process.env.PORT) || 3001;
app.listen(port, '0.0.0.0', () => console.log(`Demostración disponible en el puerto ${port}`));
