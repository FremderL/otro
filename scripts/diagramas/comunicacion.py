#!/usr/bin/env python3
"""Genera el diagrama de comunicación navegador <-> servidor <-> base de datos.

Uso:
    pip install pillow
    python3 scripts/diagramas/comunicacion.py [salida.jpg]

Sin argumentos escribe docs/arquitectura-comunicacion.jpg. El script valida la
maquetación antes de guardar: avisa (y falla) si algún texto se sale de su
tarjeta, del lienzo o se solapa con otro elemento.

Paleta: grafito, verde menta y dorado — la identidad visual de MonteCristo.
Fuentes: DejaVu Sans (regular, negrita y monoespaciada), presentes en Debian/Ubuntu
en /usr/share/fonts/truetype/dejavu. No se usan emojis porque la fuente del
sistema no trae glifos de color; los iconos se dibujan con primitivas.
"""
import os
import sys
from PIL import Image, ImageDraw, ImageFont

S = 2                      # escala de render
W, H = 1240, 1090          # tamano logico del lienzo
CX, CW = 90, 1060          # x y ancho de las tarjetas
PAD = 16                   # margen interno exigido dentro de una tarjeta

BG = (30, 35, 40)
CARD = (38, 44, 51)
CARD_EDGE = (58, 68, 79)
TXT = (232, 239, 243)
MUTED = (154, 167, 177)
MINT = (79, 224, 166)
GOLD = (231, 196, 107)
BLUE = (108, 168, 214)
RED = (226, 106, 106)
LINE = (96, 110, 124)

REG = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
MONO = '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'

ELEMENTS = []


def f(path, size):
    return ImageFont.truetype(path, int(size * S))


img = Image.new('RGB', (W * S, H * S), BG)
d = ImageDraw.Draw(img)


def record(name, bbox, inside=None, kind='texto'):
    ELEMENTS.append((name, bbox, inside, kind))


def T(xy, text, font, fill=TXT, anchor='lm', inside=None, name=None):
    d.text((xy[0] * S, xy[1] * S), text, font=font, fill=fill, anchor=anchor)
    box = d.textbbox((xy[0] * S, xy[1] * S), text, font=font, anchor=anchor)
    record(name or text[:38], [v / S for v in box], inside)


def card(name, x, y, w, h, edge=CARD_EDGE, fill=CARD):
    d.rounded_rectangle([x * S, y * S, (x + w) * S, (y + h) * S], radius=16 * S, fill=fill, outline=edge, width=2 * S)
    record(name, [x, y, x + w, y + h], None, 'tarjeta')
    return name


def band(x, y, w, h, fill):
    d.rounded_rectangle([x * S, y * S, (x + w) * S, (y + h) * S], radius=16 * S, fill=fill)
    d.rectangle([x * S, (y + h - 18) * S, (x + w) * S, (y + h) * S], fill=fill)


def arrow_down(x, y0, y1, color=LINE, width=3, name='flecha'):
    d.line([(x * S, y0 * S), (x * S, (y1 - 9) * S)], fill=color, width=int(width * S))
    d.polygon([(x * S, y1 * S), ((x - 7) * S, (y1 - 12) * S), ((x + 7) * S, (y1 - 12) * S)], fill=color)
    record(name, [x - 7, y0, x + 7, y1])


def arrow_up(x, y0, y1, color=LINE, width=3, name='flecha'):
    d.line([(x * S, y0 * S), (x * S, (y1 + 9) * S)], fill=color, width=int(width * S))
    d.polygon([(x * S, y1 * S), ((x - 7) * S, (y1 + 12) * S), ((x + 7) * S, (y1 + 12) * S)], fill=color)
    record(name, [x - 7, y1, x + 7, y0])


def chip(x, y, label, fill, text_color=BG, name=None):
    font = f(BOLD, 15)
    w = font.getlength(label) / S + 26
    d.rounded_rectangle([x * S, y * S, (x + w) * S, (y + 30) * S], radius=15 * S, fill=fill)
    T((x + w / 2, y + 16), label, font, fill=text_color, anchor='mm', name=name or ('pill ' + label))
    return w


def monitor(x, y, color, inside=None):
    d.rounded_rectangle([x * S, y * S, (x + 34) * S, (y + 25) * S], radius=4 * S, outline=color, width=int(3 * S))
    d.line([((x + 17) * S, (y + 25) * S), ((x + 17) * S, (y + 31) * S)], fill=color, width=int(3 * S))
    d.line([((x + 7) * S, (y + 32) * S), ((x + 27) * S, (y + 32) * S)], fill=color, width=int(3 * S))
    record('icono monitor', [x, y, x + 34, y + 32], inside)


def chip_icon(x, y, color, inside=None):
    d.rounded_rectangle([x * S, y * S, (x + 32) * S, (y + 32) * S], radius=6 * S, outline=color, width=int(3 * S))
    d.rounded_rectangle([(x + 9) * S, (y + 9) * S, (x + 23) * S, (y + 23) * S], radius=3 * S, outline=color, width=int(2 * S))
    for i in (5, 16, 27):
        d.line([((x + i) * S, y * S), ((x + i) * S, (y - 6) * S)], fill=color, width=int(2 * S))
        d.line([((x + i) * S, (y + 32) * S), ((x + i) * S, (y + 38) * S)], fill=color, width=int(2 * S))
        d.line([(x * S, (y + i) * S), ((x - 6) * S, (y + i) * S)], fill=color, width=int(2 * S))
        d.line([((x + 32) * S, (y + i) * S), ((x + 38) * S, (y + i) * S)], fill=color, width=int(2 * S))
    record('icono chip', [x - 6, y - 6, x + 38, y + 38], inside)


def cylinder(x, y, color, inside=None):
    d.ellipse([x * S, y * S, (x + 34) * S, (y + 14) * S], outline=color, width=int(3 * S))
    d.line([(x * S, (y + 7) * S), (x * S, (y + 30) * S)], fill=color, width=int(3 * S))
    d.line([((x + 34) * S, (y + 7) * S), ((x + 34) * S, (y + 30) * S)], fill=color, width=int(3 * S))
    d.arc([x * S, (y + 16) * S, (x + 34) * S, (y + 44) * S], 0, 180, fill=color, width=int(3 * S))
    record('icono bd', [x, y, x + 34, y + 44], inside)


# ============================================================== encabezado
T((90, 56), 'Cómo se comunican el navegador, el servidor y la base de datos', f(BOLD, 28), name='titulo')
T((90, 92), 'MonteCristo · arquitectura de comunicación', f(REG, 19), fill=MUTED, name='subtitulo')
d.line([(90 * S, 118 * S), (1150 * S, 118 * S)], fill=CARD_EDGE, width=int(2 * S))

F_TITLE, F_SUB, F_BODY, F_NOTE = f(BOLD, 25), f(REG, 18), f(REG, 19), f(REG, 18)
MONO_F = f(MONO, 17)

# ============================================================ 1 · navegador
y1 = 150
NAV = card('NAVEGADOR', CX, y1, CW, 168)
band(CX, y1, CW, 8, MINT)
monitor(CX + 34, y1 + 34, MINT, inside=NAV)
T((CX + 92, y1 + 44), 'NAVEGADOR', F_TITLE, inside=NAV, name='nav-titulo')
T((CX + 92, y1 + 72), 'public/index.html · public/app.js (cliente Socket.IO)', F_SUB, fill=MUTED, inside=NAV, name='nav-sub')
T((CX + 34, y1 + 112), 'Envía intenciones: join_room, poker_action, quick_bet, chat, reaction', F_BODY, inside=NAV)
T((CX + 34, y1 + 140), 'Pinta el estado que recibe del servidor. Nunca decide resultados ni ve cartas ajenas.', F_BODY, inside=NAV)

# ============================================================== flechas 1-2
arrow_down(150, y1 + 176, y1 + 328, name='flecha peticiones')
arrow_up(190, y1 + 328, y1 + 176, name='flecha respuestas')
w = chip(238, y1 + 216, '1) HTTP', MINT, name='pill 1')
T((238 + w + 16, y1 + 232), 'GET de la página y los assets · GET/POST /api/* · GET /healthz', MONO_F, name='label http')
w = chip(238, y1 + 266, '2) WebSocket', GOLD, name='pill 2')
T((238 + w + 16, y1 + 282), 'create_room, join_room, chat  ⇄  room_state, game_event, profile_event', MONO_F, name='label ws')

# ============================================================= 2 · servidor
y2 = 500
SRV = card('SERVIDOR', CX, y2, CW, 244)
band(CX, y2, CW, 8, GOLD)
chip_icon(CX + 37, y2 + 36, GOLD, inside=SRV)
T((CX + 92, y2 + 44), 'SERVIDOR · server.js', F_TITLE, inside=SRV, name='srv-titulo')
T((CX + 92, y2 + 72), 'Express + Socket.IO · autoritativo', F_SUB, fill=MUTED, inside=SRV, name='srv-sub')
T((CX + 34, y2 + 112), 'Express: sirve la página, /api/* y /healthz', F_BODY, inside=SRV)
T((CX + 34, y2 + 140), 'Socket.IO: salas, apuestas, chat y eventos en vivo', F_BODY, inside=SRV)
T((CX + 34, y2 + 168), 'Valida turnos, saldos y reglas; reparte cartas ocultas (XX) hasta el showdown', F_BODY, inside=SRV)
T((CX + 34, y2 + 196), 'Memoria del proceso: salas, mesas y bots (se pierden al reiniciar)', F_BODY, fill=MUTED, inside=SRV)
T((CX + 34, y2 + 222), 'Persistencia detrás de una sola interfaz: lib/*-store.js', F_BODY, fill=MUTED, inside=SRV)

# ================================================================ flecha 3
arrow_down(150, y2 + 252, y2 + 300, name='flecha persistencia')
w = chip(238, y2 + 260, '3) SQL / disco', MINT, name='pill 3')
T((238 + w + 16, y2 + 276), 'lib/*-store.js · saveNow() con reintentos   →   solo el servidor escribe', MONO_F, name='label sql')

# ========================================================= 3 · base de datos
y3 = 806
DB = card('BASE DE DATOS', CX, y3, CW, 172)
band(CX, y3, CW, 8, BLUE)
cylinder(CX + 34, y3 + 36, BLUE, inside=DB)
T((CX + 92, y3 + 44), 'PERSISTENCIA', F_TITLE, inside=DB, name='db-titulo')
T((CX + 92, y3 + 72), 'Postgres o archivos JSON, nunca ambos', F_SUB, fill=MUTED, inside=DB, name='db-sub')
T((CX + 34, y3 + 112), 'Con DATABASE_URL → Postgres: montecristo_profiles, montecristo_seasons, football_*', F_BODY, inside=DB)
T((CX + 34, y3 + 140), 'Sin DATABASE_URL → data/profiles.json · data/lobby-tournaments.json', F_BODY, inside=DB)

# ================================================================= pie / nota
d.ellipse([92 * S, 1008 * S, (92 + 28) * S, (1008 + 28) * S], outline=RED, width=int(3 * S))
d.line([(99 * S, 1015 * S), (113 * S, 1029 * S)], fill=RED, width=int(3 * S))
d.line([(113 * S, 1015 * S), (99 * S, 1029 * S)], fill=RED, width=int(3 * S))
record('icono prohibido', [92, 1008, 120, 1036])
T((134, 1022), 'El navegador nunca se conecta a la base de datos: solo habla con el servidor.', F_NOTE,
  fill=(226, 200, 200), name='nota')
T((1150, 1022), 'docs/arquitectura-comunicacion.md', f(REG, 15), fill=(120, 132, 143), anchor='rm', name='pie')

# ================================================================= validacion
cards = {n: b for n, b, ins, k in ELEMENTS if k == 'tarjeta'}
problems = []
for name, (x0, y0, x1, y1), inside, kind in ELEMENTS:
    if kind == 'tarjeta':
        continue
    if x0 < 8 or y0 < 8 or x1 > W - 8 or y1 > H - 8:
        problems.append('FUERA DEL LIENZO: %s -> %s' % (name, [round(v, 1) for v in (x0, y0, x1, y1)]))
    if inside:
        bx0, by0, bx1, by1 = cards[inside]
        if x0 < bx0 + PAD or x1 > bx1 - PAD or y0 < by0 + 4 or y1 > by1 - 4:
            problems.append('SE SALE DE %s: %s -> %s' % (inside, name, [round(v, 1) for v in (x0, y0, x1, y1)]))

items = [(n, b, ins, k) for n, b, ins, k in ELEMENTS]
for i in range(len(items)):
    for j in range(i + 1, len(items)):
        n1, b1, ins1, k1 = items[i]
        n2, b2, ins2, k2 = items[j]
        if k1 == 'tarjeta' or k2 == 'tarjeta':
            if k1 == 'tarjeta' and k2 == 'tarjeta':
                continue
            if k1 == 'tarjeta':
                card_name, other, oins = n1, n2, ins2
            else:
                card_name, other, oins = n2, n1, ins1
            if oins == card_name:
                continue
            ox = min(b1[2], b2[2]) - max(b1[0], b2[0])
            oy = min(b1[3], b2[3]) - max(b1[1], b2[1])
            if ox > 1 and oy > 1:
                problems.append('SOLAPA con tarjeta %s: %s' % (card_name, other))
            continue
        if ins1 and ins1 == ins2:
            continue
        ox = min(b1[2], b2[2]) - max(b1[0], b2[0])
        oy = min(b1[3], b2[3]) - max(b1[1], b2[1])
        if ox > 2 and oy > 2:
            problems.append('SOLAPE: %s con %s (%.1fx%.1f px)' % (n1, n2, ox, oy))

print('--- elementos dibujados ---')
for n, b, ins, k in ELEMENTS:
    print('  %-8s %-46s %s' % (k, n[:44], [round(v) for v in b]))
if problems:
    print('--- PROBLEMAS ---')
    for p in problems:
        print('  ' + p)
    sys.exit(1)
print('--- OK: sin desbordes ni solapes ---')

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
out = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    ROOT, 'docs', 'arquitectura-comunicacion.jpg')
final = img.resize((W, H), Image.LANCZOS)
if out.lower().endswith('.jpg') or out.lower().endswith('.jpeg'):
    final.save(out, 'JPEG', quality=92, optimize=True, progressive=True, subsampling=0)
else:
    final.save(out)
print('guardado', out)
