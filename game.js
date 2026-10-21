// Котосессия — код игры. Подключается из index.html обычным тегом <script>,
// поэтому игра открывается двойным щелчком, без сервера.

"use strict";

/* ============================================================
   Размеры мира и физика
   ============================================================ */

// Размеры игрового мира и физика. Все скорости — в пикселях в секунду.
const VIEW_W = 960;
const VIEW_H = 540;
const GROUND_Y = 470;          // верх пола в коридоре

const GRAVITY = 1900;
const RUN_SPEED = 260;
const JUMP_SPEED = 690;        // хватает примерно на 125 px вверх
const MAX_FALL = 1100;
const MAX_DT = 1 / 30;         // ограничение шага после задержки
const FALL_LIMIT = 640;        // ниже этой линии — провалился в подвал

const LIVES = 3;               // зачётки
const MAX_ENERGY = 3;          // четвёртая банка — обморок


/* ============================================================
   Столкновения
   ============================================================ */

// Проверка пересечения двух прямоугольников { x, y, w, h }
function overlaps(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// Плавно приближает значение к цели не больше чем на delta за шаг
function approach(value, target, delta) {
  if (value < target) return Math.min(value + delta, target);
  return Math.max(value - delta, target);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}


/* ============================================================
   Сохранение прогресса в localStorage
   ============================================================ */

// Прогресс игрока хранится в localStorage одной JSON-строкой:
// { unlocked: 2, levels: { "1": { best: 1240, time: 41.2 } }, endlessBest: 900, endlessMeters: 120 }

const STORAGE_KEY = "kotosessiya-progress-v1";

function emptyProgress() {
  return { unlocked: 1, levels: {}, endlessBest: 0, endlessMeters: 0 };
}

function loadProgress() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return emptyProgress();

    const saved = JSON.parse(raw);
    return {
      ...emptyProgress(),
      ...saved,
      levels: { ...(saved.levels || {}) }
    };
  } catch {
    // Повреждённая запись или хранилище недоступно — начинаем с чистого листа
    return emptyProgress();
  }
}

function saveProgress(progress) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
    return true;
  } catch {
    return false;
  }
}

function resetProgress() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ничего страшного: просто вернём пустой прогресс
  }
  return emptyProgress();
}


/* ============================================================
   Ввод: клавиатура и экранные кнопки
   ============================================================ */

// Ввод: клавиатура и экранные кнопки.
// Бег — удержание влево/вправо, прыжок — Space/W/↑.
// На постах и в битве нажатия стрелок складываются в очередь, её забирает испытание.

const KEY_ACTIONS = {
  ArrowLeft: "left",
  KeyA: "left",
  ArrowRight: "right",
  KeyD: "right",
  ArrowUp: "up",
  KeyW: "up",
  ArrowDown: "down",
  KeyS: "down",
  Space: "jump"
};

class Input {
  constructor() {
    this.left = false;
    this.right = false;
    this.jumpBuffer = 0;
    this.queue = [];

    // Эти функции подставляет main.js
    this.isActive = () => false;
    this.onPauseKey = () => false;
  }

  attach() {
    window.addEventListener("keydown", (event) => {
      if (event.code === "KeyP" || event.code === "Escape") {
        if (this.onPauseKey()) event.preventDefault();
        return;
      }

      const action = KEY_ACTIONS[event.code];
      if (!action || !this.isActive()) return;

      // Пока идёт игра, стрелки и пробел не прокручивают страницу
      event.preventDefault();
      if (event.repeat) return;
      this.press(action);
    });

    window.addEventListener("keyup", (event) => {
      const action = KEY_ACTIONS[event.code];
      if (action) this.release(action);
    });

    window.addEventListener("blur", () => this.clear());
  }

  bindButtons(buttons) {
    for (const button of buttons) {
      const action = button.dataset.action;

      const down = (event) => {
        event.preventDefault();
        button.setPointerCapture?.(event.pointerId);
        button.classList.add("is-down");
        this.press(action);
      };

      const up = () => {
        if (!button.classList.contains("is-down")) return;
        button.classList.remove("is-down");
        this.release(action);
      };

      button.addEventListener("pointerdown", down);
      button.addEventListener("pointerup", up);
      button.addEventListener("pointercancel", up);
      button.addEventListener("lostpointercapture", up);
      button.addEventListener("contextmenu", (event) => event.preventDefault());
    }
  }

  press(action) {
    if (action === "left" || action === "right") this[action] = true;
    if (action === "jump" || action === "up") this.jumpBuffer = 0.12;
    if (action !== "jump") this.queue.push(action);
  }

  release(action) {
    if (action === "left" || action === "right") this[action] = false;
  }

  takeQueue() {
    const queue = this.queue;
    this.queue = [];
    return queue;
  }

  clear() {
    this.left = false;
    this.right = false;
    this.jumpBuffer = 0;
    this.queue = [];
    for (const button of document.querySelectorAll(".is-down")) {
      button.classList.remove("is-down");
    }
  }
}


/* ============================================================
   Испытания: примеры и комбо стрелок
   ============================================================ */

// Испытания на постах и в битве с экзаменом.
// math  — пример и три ответа на стрелках ← ↓ →
// combo — последовательность стрелок, иногда две стрелки нужно нажать одновременно

const ARROWS = ["left", "up", "right", "down"];
const ANSWER_DIRS = ["left", "down", "right"];
const PAIRS = [["left", "right"], ["up", "down"], ["left", "up"], ["right", "down"]];
const PAIR_WINDOW = 0.35; // сколько секунд ждать вторую стрелку пары

function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function makeMath(difficulty) {
  // Примеры всегда простые: все четыре действия, числа растут чуть-чуть с каждой парой
  const top = difficulty <= 1 ? 5 : difficulty === 2 ? 7 : 9;
  const op = ["+", "−", "×", ":"][randInt(0, 3)];
  let a;
  let b;
  let result;

  if (op === "+") {
    a = randInt(1, top + 4);
    b = randInt(1, top + 4);
    result = a + b;
  } else if (op === "−") {
    a = randInt(3, top + 9);
    b = randInt(1, a - 1);
    result = a - b;
  } else if (op === "×") {
    a = randInt(2, top);
    b = randInt(2, top);
    result = a * b;
  } else {
    b = randInt(2, top);
    result = randInt(2, top);
    a = b * result;
  }

  // Два неверных ответа рядом с правильным, чтобы было над чем подумать
  const wrong = new Set();
  while (wrong.size < 2) {
    const value = result + randInt(1, 3) * (Math.random() < 0.5 ? -1 : 1);
    if (value >= 0 && value !== result) wrong.add(value);
  }

  const values = shuffle([result, ...wrong]);

  return {
    text: `${a} ${op} ${b} = ?`,
    answers: values.map((value, index) => ({ dir: ANSWER_DIRS[index], value })),
    correctDir: ANSWER_DIRS[values.indexOf(result)]
  };
}

function makeCombo(difficulty) {
  const length = difficulty <= 1 ? 3 : difficulty === 2 ? 4 : 5;
  const pairs = difficulty <= 1 ? 0 : difficulty === 2 ? 1 : 2;
  const steps = [];

  for (let i = 0; i < length; i += 1) {
    steps.push([ARROWS[randInt(0, 3)]]);
  }

  for (let i = 0; i < pairs; i += 1) {
    steps[randInt(1, length - 1)] = PAIRS[randInt(0, PAIRS.length - 1)];
  }

  return steps;
}

class Challenge {
  constructor({ kind, difficulty, timeLimit }) {
    this.kind = kind;
    this.difficulty = difficulty;
    this.timeLimit = timeLimit;
    this.timeLeft = timeLimit;
    this.age = 0;
    this.result = null;
    this.reason = "";

    if (kind === "math") {
      Object.assign(this, makeMath(difficulty));
    } else {
      this.steps = makeCombo(difficulty);
      this.stepIndex = 0;
      this.pending = null;
    }
  }

  update(dt) {
    if (this.result) return this.result;
    this.age += dt;
    this.timeLeft -= dt;

    if (this.pending && this.age - this.pending.at > PAIR_WINDOW) {
      return this.finish("fail", "Нужно одновременно");
    }
    if (this.timeLeft <= 0) {
      this.timeLeft = 0;
      return this.finish("fail", "Время вышло");
    }
    return null;
  }

  press(dir) {
    if (this.result) return this.result;

    if (this.kind === "math") {
      this.chosen = dir;
      return dir === this.correctDir ? this.finish("ok") : this.finish("fail", "Неверный ответ");
    }

    const step = this.steps[this.stepIndex];
    if (!step.includes(dir)) return this.finish("fail", "Не та стрелка");

    if (step.length === 1) return this.advance();

    // Пара: первая стрелка запускает короткое окно ожидания второй
    if (!this.pending) {
      this.pending = { at: this.age, dirs: new Set([dir]) };
      return null;
    }

    this.pending.dirs.add(dir);
    if (this.pending.dirs.size === step.length) {
      this.pending = null;
      return this.advance();
    }
    return null;
  }

  advance() {
    this.stepIndex += 1;
    if (this.stepIndex >= this.steps.length) return this.finish("ok");
    return null;
  }

  finish(result, reason = "") {
    this.result = result;
    this.reason = reason;
    return result;
  }
}


/* ============================================================
   Бесконечная сессия
   ============================================================ */

// Бесконечная сессия: коридор достраивается кусками впереди героя
// и разбирается позади, чтобы не копить объекты в памяти.
const VITAMIN_TYPES = ["magnesium", "vitd", "omega"];

class EndlessGenerator {
  constructor() {
    this.cursor = 0;
    this.chunks = 0;
    this.vitaminIndex = 0;
  }

  start(world) {
    this.addGround(world, 0, 760);
    world.solids.push({ kind: "chair", x: 520, y: GROUND_Y - 50, w: 44, h: 50 });
    this.cursor = 760;
  }

  difficulty() {
    return Math.min(3, 1 + Math.floor(this.cursor / 3200));
  }

  extend(world, untilX) {
    while (this.cursor < untilX) {
      this.addChunk(world);
      this.chunks += 1;
      if (this.chunks % 2 === 0) this.addGateChunk(world);
    }
  }

  cleanup(world, beforeX) {
    const keep = (item) => item.x + (item.w || 0) > beforeX;
    world.solids = world.solids.filter(keep);
    world.pits = world.pits.filter(keep);
    world.vitamins = world.vitamins.filter(keep);
    world.energy = world.energy.filter(keep);
    world.puddles = world.puddles.filter(keep);
    world.gates = world.gates.filter(keep);
    world.students = world.students.filter((s) => s.max + s.w > beforeX);
  }

  addGround(world, from, to) {
    world.solids.push({ kind: "ground", x: from, y: GROUND_Y, w: to - from, h: VIEW_H - GROUND_Y + 60 });
  }

  addPit(world, x, width) {
    world.pits.push({ x, w: width });
  }

  nextVitamin(x, y) {
    const type = VITAMIN_TYPES[this.vitaminIndex % VITAMIN_TYPES.length];
    this.vitaminIndex += 1;
    return { type, x, y, w: 28, h: 30, taken: false };
  }

  addChunk(world) {
    const x = this.cursor;
    const d = this.difficulty();
    const pick = Math.floor(Math.random() * 5);

    if (pick === 0) {
      // Два стула и банка на одном из них
      this.addGround(world, x, x + 700);
      world.solids.push({ kind: "chair", x: x + 200, y: GROUND_Y - 50, w: 44, h: 50 });
      world.solids.push({ kind: "chair", x: x + 460, y: GROUND_Y - 50, w: 44, h: 50 });
      world.energy.push({ x: x + 472, y: GROUND_Y - 82, w: 20, h: 30, taken: false });
      if (Math.random() < 0.6) world.energy.push({ x: x + 330, y: GROUND_Y - 32, w: 20, h: 30, taken: false });
      this.cursor = x + 700;
    } else if (pick === 1) {
      // Яма на ремонт и подоконник перед ней
      const pit = 80 + d * 15;
      this.addGround(world, x, x + 300);
      this.addPit(world, x + 300, pit);
      this.addGround(world, x + 300 + pit, x + 640 + pit);
      world.solids.push({ kind: "chair", x: x + 60, y: GROUND_Y - 50, w: 44, h: 50 });
      world.solids.push({ kind: "sill", x: x + 150, y: 360, w: 120, h: 14 });
      if (Math.random() < 0.45) world.vitamins.push(this.nextVitamin(x + 196, 328));
      this.cursor = x + 640 + pit;
    } else if (pick === 2) {
      // Студент ходит туда-сюда, за ним скамейка
      this.addGround(world, x, x + 800);
      world.students.push({
        x: x + 150, y: GROUND_Y - 46, w: 26, h: 46,
        min: x + 150, max: x + 560, speed: 60 + d * 20,
        dir: 1, cooldown: 0, phase: 0, look: this.chunks % 4
      });
      world.solids.push({ kind: "bench", x: x + 620, y: GROUND_Y - 40, w: 130, h: 40 });
      world.energy.push({ x: x + 675, y: GROUND_Y - 72, w: 20, h: 30, taken: false });
      this.cursor = x + 800;
    } else if (pick === 3) {
      // Стул-ступенька, шкаф и витамин наверху
      this.addGround(world, x, x + 700);
      world.solids.push({ kind: "chair", x: x + 150, y: GROUND_Y - 50, w: 44, h: 50 });
      world.solids.push({ kind: "locker", x: x + 220, y: GROUND_Y - 100, w: 64, h: 100 });
      if (Math.random() < 0.55) world.vitamins.push(this.nextVitamin(x + 238, GROUND_Y - 132));
      else world.energy.push({ x: x + 242, y: GROUND_Y - 132, w: 20, h: 30, taken: false });
      world.energy.push({ x: x + 420, y: GROUND_Y - 32, w: 20, h: 30, taken: false });
      this.cursor = x + 700;
    } else {
      // Пролитый кофе прямо перед ямой
      const pit = 90 + d * 10;
      this.addGround(world, x, x + 460);
      world.puddles.push({ x: x + 180, w: 160 });
      world.energy.push({ x: x + 90, y: GROUND_Y - 32, w: 20, h: 30, taken: false });
      this.addPit(world, x + 460, pit);
      this.addGround(world, x + 460 + pit, x + 800 + pit);
      this.cursor = x + 800 + pit;
    }
  }

  addGateChunk(world) {
    const x = this.cursor;
    const kind = this.chunks % 4 === 0 ? "combo" : "math";
    this.addGround(world, x, x + 420);
    world.gates.push({ x: x + 220, y: 0, w: 20, h: GROUND_Y, kind, open: false, anim: 0 });
    this.cursor = x + 420;
  }
}


/* ============================================================
   Графика на Canvas
   ============================================================ */

// Вся графика рисуется фигурами Canvas: внешних картинок нет.
const FONT = "'Manrope', system-ui, -apple-system, 'Segoe UI', sans-serif";
const SERIF = "'Playfair Display', Georgia, 'Times New Roman', serif";

const COLORS = {
  ink: "#1d2a5a",
  blue: "#4f6bed",
  blueSoft: "#dfe6ff",
  white: "#ffffff",
  red: "#ff5a4e",
  green: "#2fbf71",
  wall: "#e4ecf2",
  wallLow: "#a9bccb",
  wallLine: "#8ea6b8",
  ceiling: "#cfd9e1",
  floor: "#c98b5b",
  floorTop: "#e2a878",
  floorDark: "#9c6440",
  cat: "#f0913f",
  catStripe: "#c9661f",
  catLight: "#fff3e4",
  pink: "#f6a5b4",
  hoodie: "#6f8cff",
  hoodieDark: "#4f6bed",
  steel: "#c7cfd9",
  steelDark: "#8792a3",
  energy: "#7cff6b"
};

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

const ARROW_ANGLE = { right: 0, down: Math.PI / 2, left: Math.PI, up: -Math.PI / 2 };

function drawArrow(ctx, dir, cx, cy, size, color) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(ARROW_ANGLE[dir]);
  ctx.fillStyle = color;
  const s = size / 2;
  ctx.beginPath();
  ctx.moveTo(s, 0);
  ctx.lineTo(0, -s * 0.85);
  ctx.lineTo(0, -s * 0.35);
  ctx.lineTo(-s, -s * 0.35);
  ctx.lineTo(-s, s * 0.35);
  ctx.lineTo(0, s * 0.35);
  ctx.lineTo(0, s * 0.85);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/* ---------------- Коридор ---------------- */

const POSTERS = ["Расписание", "Сессия близко", "Не бегать!", "Клуб котиков", "хочу домой", "Столовая →"];

function drawCorridor(ctx, camX, time) {
  ctx.fillStyle = COLORS.wall;
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);

  // Окна с закатом: пиксельные облака и квадратное солнце
  const spacing = 560;
  const first = Math.floor((camX - 260) / spacing);
  for (let k = first; k < first + 4; k += 1) {
    const wx = 200 + k * spacing - camX;
    drawWindow(ctx, wx, 70, camX, time, k);

    drawPoster(ctx, wx + 400, 150, POSTERS[((k % POSTERS.length) + POSTERS.length) % POSTERS.length], k);
  }

  // Нижняя крашеная панель
  ctx.fillStyle = COLORS.wallLow;
  ctx.fillRect(0, 360, VIEW_W, GROUND_Y - 360);
  ctx.fillStyle = COLORS.wallLine;
  ctx.fillRect(0, 356, VIEW_W, 6);

  // Двери аудиторий между окнами
  for (let k = first; k < first + 4; k += 1) {
    drawClassDoor(ctx, 200 + k * spacing - camX + 300, 101 + ((k % 9) + 9) % 9);
  }

  // Потолок и лампы
  ctx.fillStyle = COLORS.ceiling;
  ctx.fillRect(0, 0, VIEW_W, 26);
  const lampSpacing = 280;
  const lampFirst = Math.floor(camX / lampSpacing);
  for (let k = lampFirst; k < lampFirst + 5; k += 1) {
    const lx = 80 + k * lampSpacing - camX;
    ctx.fillStyle = "#fffdf2";
    roundRect(ctx, lx, 26, 120, 8, 4);
    ctx.fill();
    const glow = ctx.createRadialGradient(lx + 60, 30, 4, lx + 60, 30, 150);
    glow.addColorStop(0, "rgba(255, 250, 225, 0.45)");
    glow.addColorStop(1, "rgba(255, 250, 225, 0)");
    ctx.fillStyle = glow;
    ctx.fillRect(lx - 90, 26, 300, 170);
  }
}

function drawWindow(ctx, x, y, camX, time, seed) {
  const w = 220;
  const h = 200;
  if (x > VIEW_W || x + w < 0) return;

  ctx.save();
  roundRect(ctx, x, y, w, h, 6);
  ctx.clip();

  const sky = ctx.createLinearGradient(0, y, 0, y + h);
  sky.addColorStop(0, "#4a5a9e");
  sky.addColorStop(0.55, "#f29a5c");
  sky.addColorStop(1, "#ffd28a");
  ctx.fillStyle = sky;
  ctx.fillRect(x, y, w, h);

  // солнце-квадрат
  ctx.fillStyle = "#fff3c4";
  ctx.fillRect(x + 120, y + 112, 34, 34);
  ctx.fillStyle = "rgba(255, 243, 196, 0.35)";
  ctx.fillRect(x + 108, y + 100, 58, 58);

  // облака из блоков, плывут медленнее стены
  const drift = (time * 8 + camX * 0.15 + seed * 70) % (w + 120);
  ctx.fillStyle = "#f6a76b";
  for (let i = 0; i < 3; i += 1) {
    const cx = x + ((drift + i * 110) % (w + 120)) - 80;
    const cy = y + 30 + i * 26;
    ctx.fillRect(cx, cy, 48, 10);
    ctx.fillRect(cx + 12, cy - 8, 30, 8);
  }

  // холмы из блоков
  ctx.fillStyle = "#2f5a3a";
  const steps = [0, -10, -18, -12, -24, -30, -20, -10, -16, 0, -8];
  steps.forEach((dy, i) => ctx.fillRect(x + i * 22, y + h - 34 + dy, 22, 40 - dy));
  ctx.restore();

  // рама
  ctx.strokeStyle = COLORS.white;
  ctx.lineWidth = 8;
  roundRect(ctx, x, y, w, h, 6);
  ctx.stroke();
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(x + w / 2, y);
  ctx.lineTo(x + w / 2, y + h);
  ctx.moveTo(x, y + 80);
  ctx.lineTo(x + w, y + 80);
  ctx.stroke();

  // подоконник-декор и батарея
  ctx.fillStyle = "#f7f9fb";
  ctx.fillRect(x - 10, y + h + 2, w + 20, 8);
  ctx.fillStyle = "#d7dde3";
  for (let i = 0; i < 9; i += 1) ctx.fillRect(x + 30 + i * 18, y + h + 20, 12, 40);
}

function drawClassDoor(ctx, x, number) {
  if (x > VIEW_W || x + 80 < 0) return;
  ctx.fillStyle = "#7a5638";
  ctx.fillRect(x - 4, GROUND_Y - 158, 78, 158);
  ctx.fillStyle = "#9a7048";
  ctx.fillRect(x, GROUND_Y - 154, 70, 154);
  ctx.fillStyle = "#c9e3f2";
  ctx.fillRect(x + 16, GROUND_Y - 136, 38, 34);
  ctx.fillStyle = COLORS.white;
  roundRect(ctx, x + 12, GROUND_Y - 176, 46, 16, 4);
  ctx.fill();
  ctx.fillStyle = COLORS.ink;
  ctx.font = `800 10px ${FONT}`;
  ctx.textAlign = "center";
  ctx.fillText(`Ауд. ${number}`, x + 35, GROUND_Y - 164);
  ctx.textAlign = "left";
  ctx.fillStyle = "#e3c27a";
  ctx.fillRect(x + 56, GROUND_Y - 80, 8, 4);
}

function drawPoster(ctx, x, y, text, seed) {
  if (x > VIEW_W || x + 110 < 0) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate((seed % 2 === 0 ? -1 : 1) * 0.04);
  ctx.fillStyle = seed % 3 === 0 ? "#fff6c9" : COLORS.white;
  ctx.fillRect(0, 0, 100, 64);
  ctx.fillStyle = COLORS.blue;
  ctx.fillRect(0, 0, 100, 6);
  ctx.fillStyle = COLORS.ink;
  ctx.font = `700 12px ${SERIF}`;
  ctx.fillText(text, 8, 30);
  ctx.fillStyle = "rgba(29, 42, 90, 0.25)";
  ctx.fillRect(8, 40, 70, 3);
  ctx.fillRect(8, 48, 54, 3);
  ctx.fillStyle = COLORS.red;
  ctx.beginPath();
  ctx.arc(50, 4, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/* ---------------- Мебель и пол ---------------- */

function drawSolid(ctx, s) {
  if (s.kind === "ground") {
    ctx.fillStyle = COLORS.floorDark;
    ctx.fillRect(s.x, s.y, s.w, s.h);
    ctx.fillStyle = COLORS.floor;
    ctx.fillRect(s.x, s.y, s.w, 30);
    ctx.fillStyle = COLORS.floorTop;
    ctx.fillRect(s.x, s.y, s.w, 5);
    ctx.fillStyle = "rgba(0, 0, 0, 0.08)";
    for (let x = s.x + ((40 - (s.x % 40)) % 40); x < s.x + s.w; x += 40) ctx.fillRect(x, s.y + 5, 2, 25);
    // плинтус
    ctx.fillStyle = "#7d8f9e";
    ctx.fillRect(s.x, s.y - 6, s.w, 6);
  } else if (s.kind === "chair") {
    ctx.fillStyle = COLORS.steelDark;
    ctx.fillRect(s.x + 4, s.y + 22, 4, s.h - 22);
    ctx.fillRect(s.x + s.w - 8, s.y + 22, 4, s.h - 22);
    ctx.fillRect(s.x + 4, s.y - 26, 4, 30);
    ctx.fillStyle = COLORS.blue;
    roundRect(ctx, s.x, s.y + 14, s.w, 10, 4);
    ctx.fill();
    roundRect(ctx, s.x, s.y - 30, 18, 26, 4);
    ctx.fill();
    // верх сиденья — та самая опора
    ctx.fillStyle = "#7c93ff";
    ctx.fillRect(s.x, s.y, s.w, 4);
    ctx.fillStyle = "rgba(79, 107, 237, 0.0)";
  } else if (s.kind === "bench") {
    ctx.fillStyle = "#6f4f33";
    ctx.fillRect(s.x + 10, s.y + 10, 8, s.h - 10);
    ctx.fillRect(s.x + s.w - 18, s.y + 10, 8, s.h - 10);
    ctx.fillStyle = "#b07a4a";
    roundRect(ctx, s.x, s.y, s.w, 12, 3);
    ctx.fill();
    ctx.fillStyle = "#c98f5a";
    ctx.fillRect(s.x, s.y, s.w, 4);
  } else if (s.kind === "sill") {
    ctx.fillStyle = "#f7f9fb";
    roundRect(ctx, s.x, s.y, s.w, s.h, 3);
    ctx.fill();
    ctx.fillStyle = "#c4ced8";
    ctx.fillRect(s.x, s.y + s.h - 3, s.w, 3);
  } else if (s.kind === "locker") {
    ctx.fillStyle = "#4a63d8";
    roundRect(ctx, s.x, s.y, s.w, s.h, 4);
    ctx.fill();
    ctx.fillStyle = "#3a4fb5";
    ctx.fillRect(s.x + s.w / 2 - 1, s.y + 6, 2, s.h - 10);
    ctx.fillStyle = "rgba(255, 255, 255, 0.35)";
    for (let i = 0; i < 4; i += 1) {
      ctx.fillRect(s.x + 8, s.y + 14 + i * 6, 20, 2);
      ctx.fillRect(s.x + s.w - 28, s.y + 14 + i * 6, 20, 2);
    }
    ctx.fillStyle = "#ffd36b";
    ctx.fillRect(s.x + 24, s.y + 70, 4, 10);
    ctx.fillRect(s.x + s.w - 28, s.y + 70, 4, 10);
    ctx.fillStyle = "#7f95ff";
    ctx.fillRect(s.x, s.y, s.w, 4);
  }
}

function drawPit(ctx, pit, time) {
  const g = ctx.createLinearGradient(0, GROUND_Y, 0, VIEW_H);
  g.addColorStop(0, "#2a2230");
  g.addColorStop(1, "#0d0b12");
  ctx.fillStyle = g;
  ctx.fillRect(pit.x, GROUND_Y - 6, pit.w, VIEW_H - GROUND_Y + 10);

  // лента ограждения
  for (const edge of [pit.x - 4, pit.x + pit.w - 4]) {
    ctx.fillStyle = "#3a3a3a";
    ctx.fillRect(edge, GROUND_Y - 46, 8, 46);
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(pit.x, GROUND_Y - 44, pit.w, 10);
  ctx.clip();
  for (let x = pit.x - 20; x < pit.x + pit.w + 20; x += 20) {
    ctx.fillStyle = "#ffd23f";
    ctx.beginPath();
    ctx.moveTo(x, GROUND_Y - 34);
    ctx.lineTo(x + 10, GROUND_Y - 44);
    ctx.lineTo(x + 20, GROUND_Y - 44);
    ctx.lineTo(x + 10, GROUND_Y - 34);
    ctx.fill();
  }
  ctx.restore();

  ctx.fillStyle = "#ffd23f";
  roundRect(ctx, pit.x + pit.w / 2 - 30, GROUND_Y - 80 + Math.sin(time * 2) * 2, 60, 20, 4);
  ctx.fill();
  ctx.fillStyle = "#2a2230";
  ctx.font = `800 11px ${FONT}`;
  ctx.textAlign = "center";
  ctx.fillText("РЕМОНТ", pit.x + pit.w / 2, GROUND_Y - 66 + Math.sin(time * 2) * 2);
  ctx.textAlign = "left";
}

function drawPuddle(ctx, p, time) {
  ctx.fillStyle = "rgba(111, 66, 36, 0.75)";
  ctx.beginPath();
  ctx.ellipse(p.x + p.w / 2, GROUND_Y + 3, p.w / 2, 6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
  for (let i = 0; i < 3; i += 1) {
    const x = p.x + 24 + i * (p.w / 3) + Math.sin(time * 2 + i) * 4;
    ctx.fillRect(x, GROUND_Y + 1, 16, 2);
  }
  // стаканчик
  ctx.fillStyle = COLORS.white;
  ctx.save();
  ctx.translate(p.x + p.w - 14, GROUND_Y - 4);
  ctx.rotate(1.3);
  ctx.fillRect(-6, -8, 12, 16);
  ctx.fillStyle = "#8a5a35";
  ctx.fillRect(-6, -8, 12, 4);
  ctx.restore();
}

function drawGate(ctx, g, time, active) {
  const open = g.anim || 0;
  const panelTop = GROUND_Y - 170 + open * 160;

  // стойки и табло
  ctx.fillStyle = COLORS.steelDark;
  ctx.fillRect(g.x - 8, GROUND_Y - 190, 6, 190);
  ctx.fillRect(g.x + g.w + 2, GROUND_Y - 190, 6, 190);

  // стеклянная створка во всю высоту прохода
  ctx.fillStyle = g.open ? "rgba(47, 191, 113, 0.25)" : "rgba(79, 107, 237, 0.3)";
  ctx.fillRect(g.x, Math.max(26, panelTop - 300), g.w, GROUND_Y - Math.max(26, panelTop - 300));
  ctx.fillStyle = g.open ? "rgba(47, 191, 113, 0.5)" : "rgba(79, 107, 237, 0.55)";
  ctx.fillRect(g.x, panelTop, g.w, GROUND_Y - panelTop);

  const pulse = active ? 0.5 + Math.sin(time * 8) * 0.5 : 0;
  ctx.fillStyle = COLORS.ink;
  roundRect(ctx, g.x - 22, GROUND_Y - 232, g.w + 44, 36, 8);
  ctx.fill();
  ctx.fillStyle = g.open ? COLORS.green : `rgba(255, ${190 + pulse * 60}, 80, 1)`;
  ctx.font = `800 20px ${FONT}`;
  ctx.textAlign = "center";
  ctx.fillText(g.open ? "✓" : g.kind === "math" ? "2×3" : "↑→↓", g.x + g.w / 2, GROUND_Y - 207);
  ctx.textAlign = "left";
}

function drawDoor(ctx, door, ready, time) {
  const { x, y, w, h } = door;
  ctx.fillStyle = "#3b2a6b";
  roundRect(ctx, x - 10, y - 40, w + 20, h + 40, 8);
  ctx.fill();
  ctx.fillStyle = "#5a46a8";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = ready ? `rgba(255, 220, 120, ${0.5 + Math.sin(time * 4) * 0.25})` : "rgba(255, 255, 255, 0.15)";
  ctx.fillRect(x, y + h - 8, w, 8);

  ctx.fillStyle = COLORS.white;
  ctx.font = `800 13px ${FONT}`;
  ctx.textAlign = "center";
  ctx.fillText("Ауд. 404", x + w / 2, y - 22);
  ctx.font = `700 11px ${FONT}`;
  ctx.fillText("ЭКЗАМЕН", x + w / 2, y - 8);
  ctx.textAlign = "left";
  ctx.fillStyle = "#ffd36b";
  ctx.fillRect(x + w - 16, y + 76, 8, 5);
}

/* ---------------- Предметы ---------------- */

const VITAMIN_LOOK = {
  magnesium: { body: "#ffffff", lid: "#4f6bed", text: "Mg" },
  vitd: { body: "#ffd23f", lid: "#ff9f1c", text: "D" },
  omega: { body: "#f7b733", lid: "#e8890c", text: "Ω3" }
};

function drawVitamin(ctx, v, time) {
  const bob = Math.sin(time * 3 + v.x * 0.01) * 3;
  const x = v.x;
  const y = v.y + bob;
  const look = VITAMIN_LOOK[v.type] || VITAMIN_LOOK.magnesium;

  const glow = ctx.createRadialGradient(x + 14, y + 15, 2, x + 14, y + 15, 30);
  glow.addColorStop(0, "rgba(120, 150, 255, 0.5)");
  glow.addColorStop(1, "rgba(120, 150, 255, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(x - 20, y - 20, 70, 70);

  if (v.type === "magnesium") {
    ctx.fillStyle = look.lid;
    roundRect(ctx, x + 4, y, 20, 8, 3);
    ctx.fill();
    ctx.fillStyle = look.body;
    roundRect(ctx, x + 2, y + 7, 24, 23, 5);
    ctx.fill();
    ctx.strokeStyle = "#c9d3ff";
    ctx.lineWidth = 1.5;
    ctx.stroke();
  } else {
    // капсула из двух половинок
    ctx.save();
    ctx.translate(x + 14, y + 15);
    ctx.rotate(-0.5);
    ctx.fillStyle = look.lid;
    roundRect(ctx, -16, -8, 16, 16, 8);
    ctx.fill();
    ctx.fillStyle = look.body;
    roundRect(ctx, -2, -8, 18, 16, 8);
    ctx.fill();
    ctx.restore();
  }

  ctx.fillStyle = COLORS.ink;
  ctx.font = `800 11px ${FONT}`;
  ctx.textAlign = "center";
  ctx.fillText(look.text, x + 14, y + 23);
  ctx.textAlign = "left";
}

function drawEnergy(ctx, e, time) {
  const bob = Math.sin(time * 4 + e.x * 0.02) * 2;
  const x = e.x;
  const y = e.y + bob;

  const glow = ctx.createRadialGradient(x + 10, y + 15, 2, x + 10, y + 15, 26);
  glow.addColorStop(0, "rgba(124, 255, 107, 0.55)");
  glow.addColorStop(1, "rgba(124, 255, 107, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(x - 16, y - 12, 54, 56);

  ctx.fillStyle = "#1c1f2b";
  roundRect(ctx, x, y + 2, 20, 28, 4);
  ctx.fill();
  ctx.fillStyle = COLORS.steel;
  ctx.fillRect(x + 2, y, 16, 4);
  ctx.fillStyle = COLORS.energy;
  ctx.beginPath();
  ctx.moveTo(x + 12, y + 7);
  ctx.lineTo(x + 5, y + 18);
  ctx.lineTo(x + 10, y + 18);
  ctx.lineTo(x + 8, y + 27);
  ctx.lineTo(x + 15, y + 15);
  ctx.lineTo(x + 10, y + 15);
  ctx.closePath();
  ctx.fill();
}

/* ---------------- Персонажи ---------------- */

// Котик Скуб. (cx, bottom) — точка между лапами на полу.
function drawCat(ctx, cx, bottom, o) {
  const scale = o.scale || 1;
  const sq = o.squash || 0;
  const sy = sq > 0 ? 1 - sq * 0.22 : 1 - sq * 0.12;
  const sx = sq > 0 ? 1 + sq * 0.22 : 1 + sq * 0.08;
  const t = o.time || 0;
  const energy = o.energy || 0;

  ctx.save();
  ctx.translate(cx, bottom);
  ctx.scale((o.facing || 1) * sx * scale, sy * scale);

  // плащ рыцаря за спиной
  if (o.knight) {
    ctx.fillStyle = "#f4f1ea";
    ctx.beginPath();
    ctx.moveTo(-10, -24);
    ctx.quadraticCurveTo(-26, -12 + Math.sin(t * 5) * 3, -22, 0);
    ctx.lineTo(-4, -2);
    ctx.closePath();
    ctx.fill();
  }

  // хвост
  ctx.strokeStyle = COLORS.cat;
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(-9, -12);
  ctx.quadraticCurveTo(-24, -14 + Math.sin(t * 4) * 3, -20, -30);
  ctx.stroke();
  ctx.strokeStyle = COLORS.catStripe;
  ctx.beginPath();
  ctx.moveTo(-21, -26);
  ctx.lineTo(-20, -30);
  ctx.stroke();

  // лапы
  const step = o.moving ? Math.sin((o.runPhase || 0) * 6) * 4 : 0;
  ctx.fillStyle = COLORS.cat;
  roundRect(ctx, -10 + step, -10, 8, 10, 3);
  ctx.fill();
  roundRect(ctx, 3 - step, -10, 8, 10, 3);
  ctx.fill();
  ctx.fillStyle = COLORS.catLight;
  ctx.fillRect(-10 + step, -3, 8, 3);
  ctx.fillRect(3 - step, -3, 8, 3);

  // туловище: худи или доспех
  if (o.knight) {
    const armor = ctx.createLinearGradient(0, -26, 0, -8);
    armor.addColorStop(0, "#eef2f7");
    armor.addColorStop(1, COLORS.steelDark);
    ctx.fillStyle = armor;
    roundRect(ctx, -12, -26, 24, 18, 6);
    ctx.fill();
    ctx.fillStyle = "#c79a3b";
    ctx.fillRect(-12, -12, 24, 3);
  } else {
    ctx.fillStyle = COLORS.hoodie;
    roundRect(ctx, -12, -25, 24, 17, 6);
    ctx.fill();
    ctx.fillStyle = COLORS.hoodieDark;
    ctx.fillRect(-7, -15, 14, 3);
    ctx.fillStyle = COLORS.white;
    ctx.fillRect(-2, -24, 1.5, 7);
    ctx.fillRect(2, -24, 1.5, 7);
  }

  // уши
  for (const side of [-1, 1]) {
    ctx.fillStyle = COLORS.cat;
    ctx.beginPath();
    ctx.moveTo(side * 13, -41);
    ctx.lineTo(side * 9, -55);
    ctx.lineTo(side * 2, -45);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = COLORS.pink;
    ctx.beginPath();
    ctx.moveTo(side * 10.5, -43);
    ctx.lineTo(side * 8.5, -51);
    ctx.lineTo(side * 4.5, -45);
    ctx.closePath();
    ctx.fill();
  }

  // голова
  ctx.fillStyle = COLORS.cat;
  ctx.beginPath();
  ctx.ellipse(0, -35, 15.5, 13, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = COLORS.catStripe;
  ctx.fillRect(-1.5, -47, 3, 6);
  ctx.fillRect(-7, -45, 3, 5);
  ctx.fillRect(4, -45, 3, 5);

  // взъерошенная шерсть после трёх банок
  if (energy >= 3) {
    ctx.fillStyle = COLORS.cat;
    for (let i = -2; i <= 2; i += 1) {
      ctx.beginPath();
      ctx.moveTo(i * 5 - 2, -46);
      ctx.lineTo(i * 5 + Math.sin(t * 30 + i) * 2, -54);
      ctx.lineTo(i * 5 + 2, -46);
      ctx.fill();
    }
  }

  // мордочка
  ctx.fillStyle = COLORS.catLight;
  ctx.beginPath();
  ctx.ellipse(1, -29, 8.5, 5.5, 0, 0, Math.PI * 2);
  ctx.fill();

  // глаза
  const eyes = [[-5, -36], [7, -36]];
  if (energy >= 3) {
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 1.2;
    for (const [ex, ey] of eyes) {
      ctx.beginPath();
      for (let a = 0; a < Math.PI * 5; a += 0.3) {
        const r = a * 0.45;
        const px = ex + Math.cos(a + t * 10) * r;
        const py = ey + Math.sin(a + t * 10) * r;
        if (a === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.stroke();
    }
  } else if (o.blink) {
    ctx.fillStyle = COLORS.ink;
    for (const [ex, ey] of eyes) ctx.fillRect(ex - 3, ey, 6, 1.6);
  } else {
    for (const [ex, ey] of eyes) {
      ctx.fillStyle = COLORS.ink;
      ctx.beginPath();
      ctx.arc(ex, ey, o.scared ? 2.4 : 3.4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = COLORS.white;
      ctx.beginPath();
      ctx.arc(ex + 1, ey - 1.2, 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // круглые очки
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = 1.6;
  for (const [ex, ey] of eyes) {
    ctx.beginPath();
    ctx.arc(ex, ey, 5.6, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(0.6, -36);
  ctx.lineTo(1.4, -36);
  ctx.stroke();

  // нос и рот «w»
  ctx.fillStyle = COLORS.pink;
  ctx.beginPath();
  ctx.moveTo(-0.5, -31);
  ctx.lineTo(3, -31);
  ctx.lineTo(1.2, -29);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (o.happy) {
    ctx.arc(1.2, -27.5, 3, 0.1 * Math.PI, 0.9 * Math.PI);
  } else {
    ctx.moveTo(-1.8, -27);
    ctx.quadraticCurveTo(-0.3, -25.5, 1.2, -27.5);
    ctx.quadraticCurveTo(2.7, -25.5, 4.2, -27);
  }
  ctx.stroke();

  if (o.knight) {
    // шлем с пером
    const helmet = ctx.createLinearGradient(0, -52, 0, -40);
    helmet.addColorStop(0, "#f4f7fb");
    helmet.addColorStop(1, COLORS.steelDark);
    ctx.fillStyle = helmet;
    ctx.beginPath();
    ctx.ellipse(0, -43, 15, 8, 0, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(-15, -44, 30, 4);
    ctx.fillStyle = COLORS.red;
    ctx.beginPath();
    ctx.ellipse(-3, -55, 4, 8, -0.6, 0, Math.PI * 2);
    ctx.fill();

    // меч
    ctx.save();
    ctx.translate(13, -18);
    ctx.rotate(o.swordAngle ?? -0.35);
    ctx.fillStyle = "#e9eef5";
    ctx.beginPath();
    ctx.moveTo(-2, 0);
    ctx.lineTo(-2, -36);
    ctx.lineTo(0, -41);
    ctx.lineTo(2, -36);
    ctx.lineTo(2, 0);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#c79a3b";
    ctx.fillRect(-7, -1, 14, 3);
    ctx.fillStyle = "#6f4f33";
    ctx.fillRect(-1.5, 2, 3, 6);
    ctx.restore();
  } else {
    // белые наушники
    ctx.strokeStyle = "#f6f7fb";
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.arc(0, -38, 16, Math.PI * 1.08, Math.PI * 1.92);
    ctx.stroke();
    ctx.fillStyle = "#f6f7fb";
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.ellipse(side * 15, -35, 4.2, 6.2, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.strokeStyle = "#c9cfdb";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(15, -35, 4.2, 6.2, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // капля пота после двух банок
  if (energy === 2 && !o.knight) {
    ctx.fillStyle = "#8fd3ff";
    ctx.beginPath();
    ctx.arc(-14, -46 + ((t * 30) % 8), 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

const STUDENT_LOOKS = [
  { hoodie: "#ff8fab", hair: "#3b2a20" },
  { hoodie: "#2f2f3a", hair: "#d9a066" },
  { hoodie: "#3fbf9f", hair: "#1c1c1c" },
  { hoodie: "#f2c14e", hair: "#6b3f2a" }
];

function drawStudent(ctx, s, time) {
  const look = STUDENT_LOOKS[(s.look || 0) % STUDENT_LOOKS.length];
  const step = Math.sin((s.phase || 0) * 2) * 4;
  const cx = s.x + s.w / 2;
  const bottom = s.y + s.h;

  ctx.save();
  ctx.translate(cx, bottom);
  ctx.scale(s.dir, 1);
  ctx.fillStyle = "#30364a";
  ctx.fillRect(-7 + step, -14, 6, 14);
  ctx.fillRect(1 - step, -14, 6, 14);
  ctx.fillStyle = look.hoodie;
  roundRect(ctx, -11, -34, 22, 22, 6);
  ctx.fill();
  ctx.fillStyle = "#f1c9a0";
  ctx.beginPath();
  ctx.arc(1, -40, 8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = look.hair;
  ctx.beginPath();
  ctx.arc(0, -43, 8.5, Math.PI, Math.PI * 2);
  ctx.fill();
  // уткнулся в телефон
  ctx.fillStyle = "#1c1f2b";
  ctx.fillRect(7, -30, 6, 9);
  ctx.fillStyle = `rgba(160, 230, 255, ${0.6 + Math.sin(time * 6 + s.x) * 0.3})`;
  ctx.fillRect(8, -29, 4, 6);
  ctx.fillStyle = "#1c1f2b";
  ctx.fillRect(4, -40, 3, 2);
  ctx.restore();
}

/* ---------------- Экзамен ---------------- */

function drawClassroom(ctx, lines, time) {
  ctx.fillStyle = "#e7edf1";
  ctx.fillRect(0, 0, VIEW_W, VIEW_H);
  ctx.fillStyle = COLORS.wallLow;
  ctx.fillRect(0, 380, VIEW_W, GROUND_Y - 380);

  // доска
  ctx.fillStyle = "#6d4c33";
  ctx.fillRect(120, 46, 720, 250);
  ctx.fillStyle = "#2f4a3f";
  ctx.fillRect(132, 58, 696, 226);
  ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
  ctx.font = `700 22px ${SERIF}`;
  lines.forEach((line, i) => ctx.fillText(line, 170 + (i % 2) * 260, 120 + i * 56));
  ctx.fillStyle = "rgba(255, 255, 255, 0.4)";
  ctx.fillRect(700, 250, 60, 6);

  // пол
  ctx.fillStyle = COLORS.floorDark;
  ctx.fillRect(0, GROUND_Y, VIEW_W, VIEW_H - GROUND_Y);
  ctx.fillStyle = COLORS.floor;
  ctx.fillRect(0, GROUND_Y, VIEW_W, 26);
  ctx.fillStyle = COLORS.floorTop;
  ctx.fillRect(0, GROUND_Y, VIEW_W, 5);

  // часы над доской
  ctx.fillStyle = COLORS.white;
  ctx.beginPath();
  ctx.arc(480, 26, 16, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(480, 26);
  ctx.lineTo(480 + Math.cos(time) * 10, 26 + Math.sin(time) * 10);
  ctx.moveTo(480, 26);
  ctx.lineTo(480, 16);
  ctx.stroke();
}

// Экзамен-босс: огромный билет с сердитым лицом
function drawExam(ctx, cx, cy, boss, time) {
  const defeated = boss.hp <= 0;
  const flash = boss.hitAnim > 0;
  const wobble = Math.sin(time * 3) * 4;
  const tilt = defeated ? Math.min(1, (boss.outroAge || 0)) * 0.6 : Math.sin(time * 2) * 0.04;

  ctx.save();
  ctx.translate(cx + (flash ? Math.sin(time * 80) * 6 : 0), cy + wobble + (defeated ? (boss.outroAge || 0) * 60 : 0));
  ctx.rotate(tilt);
  ctx.globalAlpha = defeated ? Math.max(0, 1 - (boss.outroAge || 0) * 0.7) : 1;

  ctx.fillStyle = "rgba(29, 42, 90, 0.2)";
  roundRect(ctx, -112, -128, 230, 270, 10);
  ctx.fill();
  ctx.fillStyle = flash ? "#ffe3e0" : COLORS.white;
  roundRect(ctx, -118, -136, 230, 270, 10);
  ctx.fill();
  ctx.strokeStyle = COLORS.ink;
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.fillStyle = COLORS.ink;
  ctx.font = `800 20px ${SERIF}`;
  ctx.textAlign = "center";
  ctx.fillText("БИЛЕТ № 13", -3, -100);
  ctx.textAlign = "left";
  ctx.fillStyle = "rgba(29, 42, 90, 0.25)";
  for (let i = 0; i < 3; i += 1) ctx.fillRect(-90, -82 + i * 12, 170 - i * 30, 4);

  // брови и глаза
  ctx.fillStyle = COLORS.ink;
  ctx.save();
  ctx.translate(-40, -24);
  ctx.rotate(0.35);
  ctx.fillRect(-20, -4, 36, 8);
  ctx.restore();
  ctx.save();
  ctx.translate(36, -24);
  ctx.rotate(-0.35);
  ctx.fillRect(-16, -4, 36, 8);
  ctx.restore();
  for (const ex of [-38, 34]) {
    ctx.fillStyle = COLORS.white;
    ctx.beginPath();
    ctx.arc(ex, 0, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = COLORS.ink;
    ctx.beginPath();
    ctx.arc(ex - 4 + Math.sin(time * 2) * 2, 2, 6, 0, Math.PI * 2);
    ctx.fill();
  }

  // рот с зубами
  ctx.fillStyle = "#5a1f2a";
  roundRect(ctx, -54, 34, 104, 34, 12);
  ctx.fill();
  ctx.fillStyle = COLORS.white;
  for (let i = 0; i < 5; i += 1) {
    ctx.beginPath();
    ctx.moveTo(-48 + i * 20, 34);
    ctx.lineTo(-38 + i * 20, 48);
    ctx.lineTo(-28 + i * 20, 34);
    ctx.fill();
  }

  // красная «двойка» штампом
  ctx.save();
  ctx.translate(70, 94);
  ctx.rotate(-0.25);
  ctx.strokeStyle = COLORS.red;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(0, 0, 22, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = COLORS.red;
  ctx.font = `800 28px ${SERIF}`;
  ctx.textAlign = "center";
  ctx.fillText("2", 0, 10);
  ctx.restore();

  ctx.restore();
  ctx.textAlign = "left";
}


/* ============================================================
   Котик Скуб: движение и физика
   ============================================================ */

class Player {
  constructor() {
    this.w = 30;
    this.h = 42;
    this.reset(60, 300);
  }

  reset(x, y) {
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.onGround = false;
    this.landed = false;
    this.facing = 1;
    this.squash = 0;      // > 0 — приплюснут после приземления, < 0 — вытянут в прыжке
    this.runPhase = 0;
    this.blink = 2;
    this.stun = 0;        // после столкновения со студентом управление на миг пропадает
  }

  // env: { speedMul, isSlippery(player), worldWidth }
  update(dt, input, solids, env) {
    const control = this.stun <= 0;
    this.stun = Math.max(0, this.stun - dt);

    const dir = control ? (input.right ? 1 : 0) - (input.left ? 1 : 0) : 0;
    if (dir !== 0) this.facing = dir;

    // На пролитом кофе разгон и торможение слабые — котика заносит
    const slippery = this.onGround && env.isSlippery(this);
    let accel = 1500;
    if (!control) accel = 300;
    else if (this.onGround) accel = slippery ? 360 : 2600;
    this.vx = approach(this.vx, dir * RUN_SPEED * env.speedMul, accel * dt);

    // Прыжок только с опоры: в воздухе нажатие просто сгорает
    if (input.jumpBuffer > 0) {
      input.jumpBuffer -= dt;
      if (control && this.onGround) {
        this.vy = -JUMP_SPEED;
        this.onGround = false;
        this.squash = -1;
        input.jumpBuffer = 0;
      }
    }

    this.vy = Math.min(this.vy + GRAVITY * dt, MAX_FALL);

    // Двигаемся мелкими шагами, чтобы не проскочить сквозь тонкий подоконник
    const distance = Math.max(Math.abs(this.vx), Math.abs(this.vy)) * dt;
    const substeps = Math.max(1, Math.ceil(distance / 6));
    const stepDt = dt / substeps;
    const fallSpeed = this.vy;

    this.onGround = false;
    this.landed = false;

    for (let i = 0; i < substeps; i += 1) {
      this.moveX(this.vx * stepDt, solids, env.worldWidth);
      this.moveY(this.vy * stepDt, solids);
    }

    if (this.onGround && fallSpeed > 420) {
      this.squash = Math.min(1, fallSpeed / 900);
      this.landed = true;
    }

    this.squash = approach(this.squash, 0, dt * 4);
    this.runPhase += Math.abs(this.vx) * dt * 0.06;
    this.blink -= dt;
    if (this.blink < -0.12) this.blink = 2 + Math.random() * 2.5;
  }

  moveX(dx, solids, worldWidth) {
    this.x += dx;
    this.x = Math.max(0, Math.min(worldWidth - this.w, this.x));

    for (const s of solids) {
      if (!overlaps(this, s)) continue;
      if (dx > 0) this.x = s.x - this.w;
      else if (dx < 0) this.x = s.x + s.w;
      this.vx = 0;
    }
  }

  moveY(dy, solids) {
    this.y += dy;

    for (const s of solids) {
      if (!overlaps(this, s)) continue;
      if (dy > 0) {
        this.y = s.y - this.h;   // приземлился сверху
        this.onGround = true;
      } else if (dy < 0) {
        this.y = s.y + s.h;      // ударился головой снизу
      }
      this.vy = 0;
    }
  }
}


/* ============================================================
   Игра: состояния, уровень, посты, битва, отрисовка
   ============================================================ */

const RUNNING = new Set(["playing", "qte", "boss"]);

const SOLID_SIZES = {
  ground: { h: VIEW_H - GROUND_Y + 60 },
  chair: { w: 44, h: 50 },
  bench: { w: 130, h: 40 },
  sill: { w: 140, h: 14 },
  locker: { w: 64, h: 100 }
};

const VITAMIN_NAMES = { magnesium: "Магний", vitd: "Витамин D", omega: "Омега-3" };

const ENERGY_LINES = [
  "Энергетик! Коридор поехал сам — не отставай",
  "Второй… всё быстрее, сердце стучит",
  "Третий! Всё трясётся. Ещё один — и обморок"
];

// Скорость, с которой коридор сам едет вперёд, в зависимости от числа банок
const AUTO_SCROLL = [0, 110, 170, 230];

const BUMP_LINES = ["Ой, извини!", "Смотри, куда бежишь!", "Э, аккуратнее!", "Котик, ты чего?"];

const LOSE_TEXT = {
  late: ["Опоздал на пару", "Дверь закрыли перед носом. Преподаватель поставил «н»."],
  fall: ["Провалился на ремонт", "Под коридором оказался подвал. Экзамен оттуда не сдать."],
  faint: ["Перебор с энергетиками", "Четвёртая банка была лишней: Скуб прилёг прямо в коридоре. Витамины успокаивают, энергетики — нет."],
  expelled: ["Зачётки кончились", "Три ошибки — и тебя отправили на пересдачу."],
  behind: ["Отстал от пары", "Энергетик разогнал коридор, а Скуб застрял позади. Не останавливайся и прыгай заранее."]
};

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function makeSolid(p) {
  const size = SOLID_SIZES[p.kind];
  const solid = { kind: p.kind, x: p.x, w: p.w ?? size.w, h: size.h };
  solid.y = p.y ?? (p.kind === "ground" ? GROUND_Y : GROUND_Y - solid.h);
  return solid;
}

class Game {
  constructor(canvas, input, levels, ui) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.input = input;
    this.levels = levels;
    this.ui = ui;

    this.player = new Player();
    this.progress = loadProgress();
    this.reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

    this.state = "menu";
    this.prevState = null;
    this.mode = "story";
    this.levelIndex = 0;
    this.def = levels[0];
    this.world = null;
    this.menuWorld = this.buildWorld(levels[0]);
    this.scene = "run";
    this.camX = 0;
    this.particles = [];
    this.toast = { text: "", timer: 0 };
    this.flash = 0;
    this.shake = 0;

    this.fitCanvas();
    window.addEventListener("resize", () => this.fitCanvas());
  }

  fitCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = VIEW_W * dpr;
    this.canvas.height = VIEW_H * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /* ---------- Построение уровня из levels.json ---------- */

  buildWorld(def) {
    const world = {
      width: def.width,
      solids: [],
      pits: [],
      vitamins: [],
      energy: [],
      students: [],
      puddles: [],
      gates: [],
      door: null
    };

    const segments = [...(def.ground || [])].sort((a, b) => a[0] - b[0]);
    segments.forEach(([from, to], index) => {
      world.solids.push(makeSolid({ kind: "ground", x: from, w: to - from }));
      const next = segments[index + 1];
      if (next) world.pits.push({ x: to, w: next[0] - to });
    });

    for (const p of def.platforms || []) world.solids.push(makeSolid(p));
    for (const v of def.vitamins || []) world.vitamins.push({ ...v, w: 28, h: 30, taken: false });
    for (const e of def.energy || []) world.energy.push({ ...e, w: 20, h: 30, taken: false });
    (def.students || []).forEach((s, index) => {
      world.students.push({
        x: s.min, y: GROUND_Y - 46, w: 26, h: 46, min: s.min, max: s.max,
        speed: s.speed, dir: 1, cooldown: 0, phase: 0, look: index
      });
    });
    for (const p of def.puddles || []) world.puddles.push({ ...p });
    for (const g of def.gates || []) world.gates.push({ x: g.x, y: 0, w: 20, h: GROUND_Y, kind: g.kind, open: false, anim: 0 });
    if (def.finish) world.door = { x: def.finish, y: GROUND_Y - 150, w: 80, h: 150 };

    return world;
  }

  /* ---------- Запуск, пауза, рестарт ---------- */

  isRunning() {
    return RUNNING.has(this.state);
  }

  resetRun() {
    this.player.reset(60, GROUND_Y - this.player.h);
    this.score = 0;
    this.lives = LIVES;
    this.energy = 0;
    this.vitamins = 0;
    this.bonusTime = 0;
    this.meters = 0;
    this.camFloor = 0;
    this.camX = 0;
    this.particles = [];
    this.challenge = null;
    this.activeGate = null;
    this.boss = null;
    this.scene = "run";
    this.flash = 0;
    this.shake = 0;
    this.toast = { text: "", timer: 0 };
    this.input.clear();
  }

  startStory(index) {
    this.mode = "story";
    this.levelIndex = index;
    this.def = this.levels[index];
    this.world = this.buildWorld(this.def);
    this.generator = null;
    this.resetRun();
    this.timeLeft = this.def.time;
    this.setState("playing");
    this.showToast(`${this.def.title}: ${this.def.subject}. До экзамена ${this.def.time} секунд!`);
  }

  startEndless() {
    this.mode = "endless";
    this.def = {
      title: "Бесконечная сессия",
      subject: "Всё подряд",
      width: 1e9,
      mathLevel: 1,
      comboLevel: 1
    };
    this.world = this.buildWorld({ width: 1e9 });
    this.generator = new EndlessGenerator();
    this.generator.start(this.world);
    this.generator.extend(this.world, 2600);
    this.resetRun();
    this.timeLeft = Infinity;
    this.setState("playing");
    this.showToast("Сессия бесконечна. Беги, сколько сможешь!");
  }

  restart() {
    if (this.mode === "endless") this.startEndless();
    else this.startStory(this.levelIndex);
  }

  pause() {
    if (!this.isRunning()) return false;
    this.prevState = this.state;
    this.state = "paused";
    this.input.clear();
    this.ui.onState("paused");
    return true;
  }

  resume() {
    if (this.state !== "paused") return;
    this.input.clear();
    this.setState(this.prevState || "playing");
  }

  togglePause() {
    if (this.state === "paused") {
      this.resume();
      return true;
    }
    return this.pause();
  }

  toMenu() {
    this.input.clear();
    this.world = null;
    this.setState("menu");
  }

  resetProgress() {
    this.progress = resetProgress();
  }

  setState(state) {
    this.state = state;
    this.ui.onState(state);
  }

  /* ---------- Обновление ---------- */

  speedMul() {
    return 1 + 0.15 * this.energy;
  }

  qteTime() {
    return Math.max(2.6, 5 - 0.6 * this.energy);
  }

  difficultyFor(kind) {
    if (this.mode === "endless") return this.generator.difficulty();
    return kind === "math" ? this.def.mathLevel : this.def.comboLevel;
  }

  update(dt) {
    if (this.state === "playing") this.updateRun(dt);
    else if (this.state === "qte") this.updateGateChallenge(dt);
    else if (this.state === "boss") this.updateBoss(dt);

    this.updateEffects(dt);
  }

  updateRun(dt) {
    const p = this.player;
    const w = this.world;

    if (this.mode === "story") {
      this.timeLeft -= dt;
      if (this.timeLeft <= 0) {
        this.timeLeft = 0;
        this.lose("late");
        return;
      }
    } else {
      this.generator.extend(w, p.x + 1800);
      this.generator.cleanup(w, this.camX - 900);
    }

    const solids = w.solids.filter((s) => s.x < p.x + 220 && s.x + s.w > p.x - 220);
    for (const g of w.gates) if (!g.open) solids.push(g);

    p.update(dt, this.input, solids, {
      speedMul: this.speedMul(),
      isSlippery: (pl) => w.puddles.some((d) => pl.x + pl.w > d.x && pl.x < d.x + d.w && Math.abs(pl.y + pl.h - GROUND_Y) < 2),
      worldWidth: w.width
    });

    if (p.landed) this.dust(p.x + p.w / 2, p.y + p.h);

    // Студенты ходят туда-сюда и отталкивают котика
    const body = { x: p.x + 4, y: p.y + 4, w: p.w - 8, h: p.h - 4 };
    for (const s of w.students) {
      s.x += s.dir * s.speed * this.speedMul() * dt;
      if (s.x < s.min) { s.x = s.min; s.dir = 1; }
      if (s.x > s.max) { s.x = s.max; s.dir = -1; }
      s.phase += dt * s.speed * 0.06;
      s.cooldown = Math.max(0, s.cooldown - dt);

      if (s.cooldown <= 0 && p.stun <= 0 && overlaps(body, s)) {
        const dir = Math.sign(p.x + p.w / 2 - (s.x + s.w / 2)) || -1;
        p.vx = dir * 380;
        p.vy = -330;
        p.onGround = false;
        p.stun = 0.4;
        s.cooldown = 1.2;
        this.addScore(-50, p.x, p.y);
        this.shake = 8;
        this.showToast(pick(BUMP_LINES));
      }
    }

    // Витамины: обязательные предметы, снимают одну банку энергетика
    for (const v of w.vitamins) {
      if (v.taken || !overlaps(p, v)) continue;
      v.taken = true;
      this.vitamins += 1;
      this.energy = Math.max(0, this.energy - 1);
      this.bonusTime = 1.5;
      this.addScore(100, v.x, v.y);
      this.sparkle(v.x + 14, v.y + 15, "#8ea2ff");
      const counter = this.mode === "story" ? ` · ${Math.min(this.vitamins, 3)}/3` : "";
      this.showToast(`${VITAMIN_NAMES[v.type]}! +1,5 с на следующий пост${counter}`);
    }

    // Энергетики: быстрее, но опаснее
    for (const e of w.energy) {
      if (e.taken || !overlaps(p, e)) continue;
      e.taken = true;
      this.energy += 1;
      this.addScore(25, e.x, e.y);
      this.sparkle(e.x + 10, e.y + 15, COLORS.energy);
      if (this.energy > MAX_ENERGY) {
        this.lose("faint");
        return;
      }
      this.showToast(ENERGY_LINES[this.energy - 1]);
    }

    if (p.y > FALL_LIMIT) {
      this.lose("fall");
      return;
    }

    // Пост: стеклянная створка открывается только после испытания
    for (const g of w.gates) {
      if (g.open) {
        g.anim = Math.min(1, g.anim + dt * 2.5);
        continue;
      }
      if (p.x + p.w >= g.x - 6 && p.x < g.x) {
        this.startGateChallenge(g);
        return;
      }
    }

    // Дверь экзамена пропускает только с тремя витаминами
    if (w.door && overlaps(p, w.door)) {
      if (this.vitamins >= 3) {
        this.startBoss();
        return;
      }
      this.showToast(`Без витаминов не сдать: собрано ${this.vitamins} из 3`);
      p.x = w.door.x - p.w - 4;
      p.vx = -160;
    }

    if (this.mode === "endless") this.meters = Math.max(this.meters, Math.floor(p.x / 40));

    if (this.updateCamera(dt, solids)) return;
  }

  // Камера следует за котиком, а с энергетиком ещё и сама едет вперёд.
  // Возвращает true, если котик отстал и игра закончилась.
  updateCamera(dt, solids) {
    const p = this.player;
    const w = this.world;

    // Дальше закрытого поста или двери экзамена коридор сам не уезжает
    let limit = Math.max(0, w.width - VIEW_W);
    for (const g of w.gates) if (!g.open && g.x > p.x) limit = Math.min(limit, g.x - 320);
    if (w.door) limit = Math.min(limit, w.door.x - 400);

    const follow = clamp(p.x - 330, 0, Math.max(0, w.width - VIEW_W));
    this.camX += (follow - this.camX) * Math.min(1, dt * 8);

    const speed = AUTO_SCROLL[Math.min(this.energy, 3)];
    if (speed > 0) {
      this.camFloor = Math.min(Math.max(this.camFloor, this.camX) + speed * dt, Math.max(limit, this.camFloor));
      this.camX = Math.max(this.camX, this.camFloor);

      // Левый край экрана толкает котика вперёд
      const edge = this.camX + 6;
      if (p.x < edge) {
        p.x = edge;
        if (p.vx < 0) p.vx = 0;
        if (solids.some((s) => overlaps(p, s))) {
          this.lose("behind");
          return true;
        }
      }
    } else {
      this.camFloor = this.camX;
    }
    return false;
  }

  makeChallenge(kind, difficulty, extraTime = 0) {
    // Витамин для памяти даёт запас времени на одно следующее испытание
    const bonus = this.bonusTime;
    this.bonusTime = 0;
    // На комбо стрелок времени чуть меньше, чем на пример
    const base = kind === "combo" ? this.qteTime() * 0.8 : this.qteTime();
    return new Challenge({ kind, difficulty, timeLimit: base + extraTime + bonus });
  }

  startGateChallenge(gate) {
    this.activeGate = gate;
    this.player.vx = 0;
    this.input.clear();
    this.challenge = this.makeChallenge(gate.kind, this.difficultyFor(gate.kind));
    this.setState("qte");
  }

  // Общая обработка испытания: возвращает "ok", "fail" или null
  runChallenge(dt) {
    let result = this.challenge.update(dt);
    for (const dir of this.input.takeQueue()) {
      if (result) break;
      result = this.challenge.press(dir);
    }
    this.input.jumpBuffer = 0;
    return result;
  }

  failChallenge() {
    this.lives -= 1;
    this.flash = 0.35;
    this.shake = 12;
    this.showToast(`${this.challenge.reason || "Мимо"} · минус зачётка`);
    if (this.lives <= 0) {
      this.lose("expelled");
      return true;
    }
    return false;
  }

  updateGateChallenge(dt) {
    const result = this.runChallenge(dt);

    if (result === "ok") {
      this.activeGate.open = true;
      this.addScore(100, this.activeGate.x - 20, GROUND_Y - 240);
      this.sparkle(this.activeGate.x + 10, GROUND_Y - 120, COLORS.green);
      this.showToast("Верно! Проход открыт");
      this.challenge = null;
      this.input.clear();
      this.setState("playing");
    } else if (result === "fail") {
      if (this.failChallenge()) return;
      this.challenge = this.makeChallenge(this.challenge.kind, this.challenge.difficulty);
    }
  }

  /* ---------- Битва с экзаменом ---------- */

  startBoss() {
    this.scene = "boss";
    this.input.clear();
    this.boss = {
      hp: this.def.bossHp,
      maxHp: this.def.bossHp,
      phase: "intro",
      timer: 2,
      round: 0,
      hitAnim: 0,
      hurtAnim: 0,
      outroAge: 0
    };
    this.challenge = null;
    this.setState("boss");
    this.showToast("Скуб надевает доспехи. Экзамен начинается!");
  }

  nextBossChallenge() {
    const b = this.boss;
    const kind = b.round % 2 === 0 ? "combo" : "math";
    const base = kind === "math" ? this.def.mathLevel : this.def.comboLevel;
    const difficulty = clamp(base + Math.floor(b.round / 2), 1, 3);
    this.challenge = this.makeChallenge(kind, difficulty, 0.6);
    b.phase = "fight";
  }

  updateBoss(dt) {
    const b = this.boss;
    b.hitAnim = Math.max(0, b.hitAnim - dt);
    b.hurtAnim = Math.max(0, b.hurtAnim - dt);

    if (b.phase === "intro" || b.phase === "hit" || b.phase === "hurt") {
      b.timer -= dt;
      this.input.takeQueue();
      if (b.timer > 0) return;
      if (b.hp <= 0) {
        b.phase = "outro";
        b.timer = 1.6;
        return;
      }
      this.nextBossChallenge();
      return;
    }

    if (b.phase === "outro") {
      b.timer -= dt;
      b.outroAge += dt;
      this.input.takeQueue();
      if (b.timer <= 0) this.win();
      return;
    }

    const result = this.runChallenge(dt);

    if (result === "ok") {
      b.hp -= 1;
      b.round += 1;
      b.hitAnim = 0.7;
      b.phase = "hit";
      b.timer = 0.9;
      this.shake = 10;
      this.addScore(150, 760, 200);
      this.sparkle(800, 320, COLORS.red);
      this.challenge = null;
      this.showToast(b.hp > 0 ? "Удар мечом! Экзамен шатается" : "Экзамен повержен!");
    } else if (result === "fail") {
      if (this.failChallenge()) return;
      b.hurtAnim = 0.8;
      b.phase = "hurt";
      b.timer = 1;
      this.challenge = null;
    }
  }

  /* ---------- Победа и поражение ---------- */

  win() {
    const def = this.def;
    const timeBonus = Math.round(this.timeLeft) * 10;
    const livesBonus = this.lives * 100;
    const total = this.score + timeBonus + livesBonus;
    const grade = this.lives === 3 ? 5 : this.lives === 2 ? 4 : 3;
    const timeSpent = Number((def.time - this.timeLeft).toFixed(1));

    const key = String(def.id);
    const previous = this.progress.levels[key];
    const isRecord = !previous || total > previous.best;
    if (isRecord) this.progress.levels[key] = { best: total, time: timeSpent, grade };
    else if (!previous.grade || grade > previous.grade) previous.grade = grade;
    this.progress.unlocked = Math.max(this.progress.unlocked, Math.min(this.levels.length, this.levelIndex + 2));
    saveProgress(this.progress);

    this.score = total;
    this.setState("won");
    this.ui.onResult({
      won: true,
      title: `Сдано на ${grade}!`,
      text: `Скуб победил «${def.boss}». Время ${formatTime(timeSpent)}.`,
      lines: [
        `Очки за забег: ${total - timeBonus - livesBonus}`,
        `Бонус за время: ${timeBonus}`,
        `Бонус за зачётки: ${livesBonus}`
      ],
      score: total,
      best: this.progress.levels[key].best,
      isRecord,
      canNext: this.levelIndex < this.levels.length - 1
    });
  }

  lose(reason) {
    const [title, text] = LOSE_TEXT[reason];
    this.loseReason = reason;
    this.input.clear();

    let best;
    let isRecord = false;
    const total = this.mode === "endless" ? this.score + this.meters * 2 : this.score;

    if (this.mode === "endless") {
      isRecord = total > this.progress.endlessBest;
      if (isRecord) {
        this.progress.endlessBest = total;
        this.progress.endlessMeters = this.meters;
        saveProgress(this.progress);
      }
      best = this.progress.endlessBest;
    } else {
      // Рекорд пары запоминается и после неудачной попытки, но следующая пара не открывается
      const key = String(this.def.id);
      const previous = this.progress.levels[key];
      isRecord = total > 0 && (!previous || total > previous.best);
      if (isRecord) {
        this.progress.levels[key] = { best: total, time: null, grade: previous?.grade ?? null };
        saveProgress(this.progress);
      }
      best = this.progress.levels[key]?.best ?? 0;
    }

    this.score = total;
    this.setState("lost");
    this.ui.onResult({
      won: false,
      title,
      text,
      lines: this.mode === "endless"
        ? [`Пробежал ${this.meters} м`, `Очки: ${total}`]
        : [`Очки за забег: ${total}`, `Витамины: ${this.vitamins} из 3`],
      score: total,
      best,
      isRecord,
      canNext: false
    });
  }

  /* ---------- Эффекты ---------- */

  addScore(points, x, y) {
    this.score = Math.max(0, this.score + points);
    this.particles.push({
      kind: "text", text: points > 0 ? `+${points}` : String(points),
      x, y, vx: 0, vy: -50, life: 1, color: points > 0 ? COLORS.blue : COLORS.red,
      screen: this.scene === "boss"
    });
  }

  sparkle(x, y, color) {
    for (let i = 0; i < 14; i += 1) {
      const a = (Math.PI * 2 * i) / 14;
      this.particles.push({
        kind: "dot", x, y, vx: Math.cos(a) * 140, vy: Math.sin(a) * 140,
        life: 0.6, color, screen: this.scene === "boss"
      });
    }
  }

  dust(x, y) {
    for (let i = 0; i < 6; i += 1) {
      this.particles.push({
        kind: "dot", x, y, vx: (Math.random() - 0.5) * 120, vy: -Math.random() * 60,
        life: 0.35, color: "rgba(255, 255, 255, 0.8)", screen: false
      });
    }
  }

  showToast(text) {
    this.toast = { text, timer: 2.4 };
  }

  updateEffects(dt) {
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === "dot") p.vy += 300 * dt;
      p.life -= dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    this.toast.timer -= dt;
    this.flash = Math.max(0, this.flash - dt);
    this.shake = Math.max(0, this.shake - dt * 30);
  }

  shakeOffset() {
    if (this.reduceMotion) return { x: 0, y: 0 };
    const base = this.energy >= 3 ? 3.5 : this.energy === 2 ? 1.2 : 0;
    const amp = base + this.shake;
    if (amp <= 0) return { x: 0, y: 0 };
    return { x: (Math.random() - 0.5) * amp * 2, y: (Math.random() - 0.5) * amp * 2 };
  }

  /* ---------- Отрисовка ---------- */

  render(time) {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, VIEW_W, VIEW_H);

    if (this.state === "menu" || !this.world) {
      this.renderMenu(time);
      return;
    }

    if (this.scene === "boss") this.renderBoss(time);
    else this.renderRun(time);

    if (this.flash > 0) {
      ctx.fillStyle = `rgba(255, 90, 78, ${this.flash})`;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }
  }

  renderMenu(time) {
    const ctx = this.ctx;
    const world = this.menuWorld;
    const cam = (time * 60) % (world.width - VIEW_W);
    drawCorridor(ctx, cam, time);
    ctx.save();
    ctx.translate(-cam, 0);
    for (const pit of world.pits) drawPit(ctx, pit, time);
    for (const s of world.solids) drawSolid(ctx, s);
    ctx.restore();
    drawCat(ctx, 200, GROUND_Y, {
      time, facing: 1, moving: true, runPhase: time * 4, scale: 1.6, blink: Math.sin(time * 1.3) > 0.97
    });
  }

  renderRun(time) {
    const ctx = this.ctx;
    const w = this.world;
    const p = this.player;
    const cam = Math.round(this.camX);
    const shake = this.shakeOffset();
    const visible = (x, width) => x + width > cam - 60 && x < cam + VIEW_W + 60;

    ctx.save();
    ctx.translate(shake.x, shake.y);
    drawCorridor(ctx, cam, time);

    ctx.save();
    ctx.translate(-cam, 0);
    for (const pit of w.pits) if (visible(pit.x, pit.w)) drawPit(ctx, pit, time);
    for (const s of w.solids) if (visible(s.x, s.w)) drawSolid(ctx, s);
    for (const d of w.puddles) if (visible(d.x, d.w)) drawPuddle(ctx, d, time);
    if (w.door && visible(w.door.x, w.door.w)) drawDoor(ctx, w.door, this.vitamins >= 3, time);
    for (const g of w.gates) {
      if (visible(g.x - 40, g.w + 80)) drawGate(ctx, g, time, this.activeGate === g && this.state !== "playing");
    }
    for (const v of w.vitamins) if (!v.taken && visible(v.x, v.w)) drawVitamin(ctx, v, time);
    for (const e of w.energy) if (!e.taken && visible(e.x, e.w)) drawEnergy(ctx, e, time);
    for (const s of w.students) if (visible(s.x, s.w)) drawStudent(ctx, s, time);

    drawCat(ctx, p.x + p.w / 2, p.y + p.h, {
      time,
      facing: p.facing,
      squash: p.squash,
      moving: p.onGround && Math.abs(p.vx) > 20,
      runPhase: p.runPhase,
      blink: p.blink < 0,
      energy: this.energy,
      scared: p.stun > 0,
      scale: 1.2
    });

    this.renderParticles(false);
    ctx.restore();
    ctx.restore();

    this.renderHud(time);
    if (this.challenge && (this.state === "qte" || (this.state === "paused" && this.prevState === "qte"))) {
      this.renderChallenge(time, this.activeGate?.kind === "math" ? "Пост: реши пример" : "Пост: повтори комбо", 150);
    }
    this.renderToast();
  }

  renderBoss(time) {
    const ctx = this.ctx;
    const b = this.boss;
    const shake = this.shakeOffset();
    const won = this.state === "won";

    ctx.save();
    ctx.translate(shake.x, shake.y);
    drawClassroom(ctx, this.def.board || ["2 + 2 = ?"], time);

    if (won) b.outroAge = Math.max(b.outroAge, 1.6);
    drawExam(ctx, 836, 330, b, time);

    // выпад котика при ударе
    const lunge = b.hitAnim > 0 ? Math.sin((b.hitAnim / 0.7) * Math.PI) * 360 : 0;
    const recoil = b.hurtAnim > 0 ? -Math.sin((b.hurtAnim / 0.8) * Math.PI) * 30 : 0;
    const hop = won ? Math.abs(Math.sin(time * 5)) * 30 : 0;
    const swordAngle = won ? -1.6 + Math.sin(time * 5) * 0.3 : b.hitAnim > 0 ? 0.9 : -0.35;

    drawCat(ctx, 230 + lunge + recoil, GROUND_Y - hop, {
      time, facing: 1, scale: 2.6, knight: true, swordAngle,
      energy: this.energy, happy: won || b.hitAnim > 0, scared: b.hurtAnim > 0,
      blink: Math.sin(time * 1.7) > 0.97
    });

    // взмах меча
    if (b.hitAnim > 0) {
      ctx.strokeStyle = `rgba(255, 255, 255, ${b.hitAnim})`;
      ctx.lineWidth = 10;
      ctx.beginPath();
      ctx.arc(760, 330, 120, -1.2, 0.9);
      ctx.stroke();
    }

    // экзамен швыряет «двойку»
    if (b.hurtAnim > 0) {
      const k = 1 - b.hurtAnim / 0.8;
      ctx.fillStyle = COLORS.red;
      ctx.font = `800 54px ${SERIF}`;
      ctx.fillText("2", 780 - k * 520, 320 - Math.sin(k * Math.PI) * 120);
    }

    // конфетти после победы
    if (won) {
      const colors = [COLORS.blue, COLORS.red, "#ffd23f", COLORS.green, "#ff8fab"];
      for (let i = 0; i < 70; i += 1) {
        const x = (i * 137 + time * 40 * ((i % 3) + 1)) % VIEW_W;
        const y = (i * 53 + time * 120 * ((i % 4) + 1)) % VIEW_H;
        ctx.fillStyle = colors[i % colors.length];
        ctx.fillRect(x, y, 6, 10);
      }
    }

    this.renderParticles(true);
    ctx.restore();

    // полоска здоровья экзамена
    if (b.hp > 0 || !won) {
      const x = 690;
      const y = 488;
      ctx.fillStyle = "rgba(29, 42, 90, 0.85)";
      roundRect(ctx, x, y, 260, 34, 17);
      ctx.fill();
      ctx.fillStyle = COLORS.white;
      ctx.font = `800 12px ${FONT}`;
      ctx.fillText("ЭКЗАМЕН", x + 14, y + 22);
      for (let i = 0; i < b.maxHp; i += 1) {
        ctx.fillStyle = i < b.hp ? COLORS.red : "rgba(255, 255, 255, 0.25)";
        roundRect(ctx, x + 90 + i * 32, y + 9, 26, 16, 5);
        ctx.fill();
      }
    }

    this.renderHud(time);
    if (b.phase === "fight" && this.challenge) this.renderChallenge(time, "Битва: удар комбо", 96);
    if (b.phase === "intro") this.renderBanner("Скуб надевает доспехи…");
    this.renderToast();
  }

  renderParticles(screenSpace) {
    const ctx = this.ctx;
    for (const p of this.particles) {
      if (Boolean(p.screen) !== screenSpace) continue;
      ctx.globalAlpha = Math.max(0, Math.min(1, p.life * 1.5));
      if (p.kind === "text") {
        ctx.fillStyle = p.color;
        ctx.font = `800 18px ${FONT}`;
        ctx.fillText(p.text, p.x, p.y);
      } else {
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - 3, p.y - 3, 6, 6);
      }
    }
    ctx.globalAlpha = 1;
  }

  renderHud(time) {
    const ctx = this.ctx;

    // левая карточка: зачётки, витамины, батарейка энергии
    ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
    roundRect(ctx, 12, 12, 360, 52, 18);
    ctx.fill();

    for (let i = 0; i < LIVES; i += 1) {
      const x = 26 + i * 26;
      ctx.fillStyle = i < this.lives ? COLORS.blue : "rgba(79, 107, 237, 0.18)";
      roundRect(ctx, x, 24, 20, 28, 4);
      ctx.fill();
      ctx.fillStyle = i < this.lives ? COLORS.white : "rgba(255, 255, 255, 0.5)";
      ctx.fillRect(x + 4, 30, 12, 2);
      ctx.fillRect(x + 4, 36, 9, 2);
    }

    const vitaminColors = ["#8ea2ff", "#ffd23f", "#f7b733"];
    ctx.fillStyle = COLORS.ink;
    ctx.font = `800 11px ${FONT}`;
    ctx.fillText("ВИТАМИНЫ", 112, 30);
    for (let i = 0; i < 3; i += 1) {
      ctx.fillStyle = i < this.vitamins ? vitaminColors[i] : "rgba(29, 42, 90, 0.1)";
      ctx.beginPath();
      ctx.arc(120 + i * 22, 45, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = i < this.vitamins ? COLORS.ink : "rgba(29, 42, 90, 0.2)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    ctx.fillStyle = COLORS.ink;
    ctx.fillText("ЭНЕРГИЯ", 198, 30);
    const shaking = this.energy >= 3 && !this.reduceMotion ? Math.sin(time * 40) * 1.5 : 0;
    ctx.strokeStyle = COLORS.ink;
    ctx.lineWidth = 2;
    roundRect(ctx, 198 + shaking, 36, 74, 18, 4);
    ctx.stroke();
    ctx.fillStyle = COLORS.ink;
    ctx.fillRect(273 + shaking, 41, 4, 8);
    const energyColors = [COLORS.green, "#ffb020", COLORS.red];
    for (let i = 0; i < MAX_ENERGY; i += 1) {
      ctx.fillStyle = i < this.energy ? energyColors[Math.min(this.energy - 1, 2)] : "rgba(29, 42, 90, 0.08)";
      ctx.fillRect(202 + shaking + i * 23, 40, 20, 10);
    }
    ctx.fillStyle = this.energy >= 3 ? COLORS.red : COLORS.ink;
    ctx.font = `800 12px ${FONT}`;
    ctx.fillText(`${this.energy}/3`, 290, 50);

    // правая карточка: время или метры и очки
    ctx.fillStyle = "rgba(255, 255, 255, 0.92)";
    roundRect(ctx, VIEW_W - 252, 12, 240, 52, 18);
    ctx.fill();
    ctx.fillStyle = COLORS.ink;
    ctx.font = `800 11px ${FONT}`;
    ctx.fillText(this.mode === "endless" ? "ПРОБЕЖАЛ" : "ДО ЭКЗАМЕНА", VIEW_W - 236, 30);
    ctx.fillText("СЧЁТ", VIEW_W - 110, 30);
    ctx.font = `800 20px ${FONT}`;
    const late = this.mode === "story" && this.timeLeft < 15;
    ctx.fillStyle = late ? COLORS.red : COLORS.blue;
    ctx.fillText(this.mode === "endless" ? `${this.meters} м` : formatTime(this.timeLeft), VIEW_W - 236, 54);
    ctx.fillStyle = COLORS.ink;
    ctx.fillText(String(this.score), VIEW_W - 110, 54);

    // полоска пути до аудитории
    if (this.mode === "story" && this.scene === "run" && this.world.door) {
      const x = 392;
      const width = 300;
      const k = clamp(this.player.x / this.world.door.x, 0, 1);
      ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
      roundRect(ctx, x, 32, width, 10, 5);
      ctx.fill();
      ctx.fillStyle = COLORS.blue;
      roundRect(ctx, x, 32, Math.max(10, width * k), 10, 5);
      ctx.fill();
      ctx.fillStyle = "#5a46a8";
      roundRect(ctx, x + width - 6, 22, 16, 30, 3);
      ctx.fill();
      ctx.fillStyle = COLORS.cat;
      ctx.beginPath();
      ctx.arc(x + width * k, 37, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = COLORS.ink;
      ctx.fillRect(x + width * k - 4, 35, 2, 3);
      ctx.fillRect(x + width * k + 2, 35, 2, 3);
    }
  }

  renderChallenge(time, title, top, dim = 0.3) {
    const ctx = this.ctx;
    const c = this.challenge;
    const shaky = this.energy >= 3 && !this.reduceMotion;
    const j = () => (shaky ? (Math.random() - 0.5) * 7 : 0);

    if (this.scene === "run") {
      ctx.fillStyle = `rgba(29, 42, 90, ${dim})`;
      ctx.fillRect(0, 0, VIEW_W, VIEW_H);
    }

    const x = 230;
    const w = 500;
    const h = 220;
    const y = top;

    ctx.fillStyle = "rgba(29, 42, 90, 0.25)";
    roundRect(ctx, x + 4, y + 8, w, h, 26);
    ctx.fill();
    ctx.fillStyle = COLORS.white;
    roundRect(ctx, x, y, w, h, 26);
    ctx.fill();

    ctx.fillStyle = COLORS.blue;
    roundRect(ctx, x + 20, y - 14, 220, 30, 15);
    ctx.fill();
    ctx.fillStyle = COLORS.white;
    ctx.font = `800 13px ${FONT}`;
    ctx.fillText(title, x + 36, y + 6);

    if (c.kind === "math") {
      ctx.textAlign = "center";
      ctx.font = `800 52px ${SERIF}`;
      if (shaky) {
        ctx.fillStyle = "rgba(255, 90, 78, 0.35)";
        ctx.fillText(c.text, x + w / 2 + 6 + j(), y + 82 + j());
      }
      ctx.fillStyle = COLORS.ink;
      ctx.fillText(c.text, x + w / 2 + j(), y + 82 + j());

      c.answers.forEach((answer, index) => {
        const ax = x + 40 + index * 145 + j();
        const ay = y + 104 + j();
        ctx.fillStyle = COLORS.blueSoft;
        roundRect(ctx, ax, ay, 130, 70, 18);
        ctx.fill();
        drawArrow(ctx, answer.dir, ax + 34, ay + 35, 30, COLORS.blue);
        ctx.fillStyle = COLORS.ink;
        ctx.font = `800 30px ${FONT}`;
        ctx.fillText(String(answer.value), ax + 88, ay + 46);
      });
      ctx.textAlign = "left";
    } else {
      const sizes = c.steps.map((step) => (step.length > 1 ? 112 : 70));
      const total = sizes.reduce((sum, s) => sum + s, 0) + (c.steps.length - 1) * 10;
      let cx = x + (w - total) / 2;
      const cy = y + 46;

      c.steps.forEach((step, index) => {
        const width = sizes[index];
        const done = index < c.stepIndex;
        const current = index === c.stepIndex;
        const ox = j();
        const oy = j();
        ctx.fillStyle = done ? "#dff7ea" : current ? COLORS.blueSoft : "#f1f3f9";
        roundRect(ctx, cx + ox, cy + oy, width, 70, 18);
        ctx.fill();
        if (current) {
          ctx.strokeStyle = COLORS.blue;
          ctx.lineWidth = 2 + Math.sin(time * 10) * 1;
          ctx.stroke();
        }
        const color = done ? COLORS.green : COLORS.ink;
        if (step.length === 1) {
          drawArrow(ctx, step[0], cx + ox + width / 2, cy + oy + 35, 38, color);
        } else {
          drawArrow(ctx, step[0], cx + ox + 28, cy + oy + 35, 32, color);
          ctx.fillStyle = color;
          ctx.font = `800 22px ${FONT}`;
          ctx.textAlign = "center";
          ctx.fillText("+", cx + ox + width / 2, cy + oy + 43);
          ctx.textAlign = "left";
          drawArrow(ctx, step[1], cx + ox + width - 28, cy + oy + 35, 32, color);
        }
        cx += width + 10;
      });

      ctx.fillStyle = COLORS.ink;
      ctx.font = `700 14px ${FONT}`;
      ctx.textAlign = "center";
      const hasPair = c.steps.some((step) => step.length > 1);
      ctx.fillText(hasPair ? "Повтори по порядку. «+» — нажми две стрелки одновременно" : "Повтори стрелки по порядку", x + w / 2, y + 150);
      ctx.textAlign = "left";
    }

    // полоска времени
    const k = c.timeLeft / c.timeLimit;
    ctx.fillStyle = "#eef1f8";
    roundRect(ctx, x + 30, y + h - 34, w - 60, 14, 7);
    ctx.fill();
    ctx.fillStyle = c.timeLeft < 1.5 ? COLORS.red : COLORS.blue;
    roundRect(ctx, x + 30, y + h - 34, Math.max(14, (w - 60) * k), 14, 7);
    ctx.fill();
    ctx.fillStyle = COLORS.ink;
    ctx.font = `800 12px ${FONT}`;
    ctx.fillText(`${c.timeLeft.toFixed(1)} с`, x + w - 74, y + h - 42);
  }

  renderBanner(text) {
    const ctx = this.ctx;
    ctx.fillStyle = "rgba(29, 42, 90, 0.85)";
    roundRect(ctx, 260, 24, 440, 56, 28);
    ctx.fill();
    ctx.fillStyle = COLORS.white;
    ctx.font = `800 22px ${SERIF}`;
    ctx.textAlign = "center";
    ctx.fillText(text, 480, 60);
    ctx.textAlign = "left";
  }

  renderToast() {
    if (this.toast.timer <= 0 || !this.toast.text) return;
    const ctx = this.ctx;
    ctx.font = `800 16px ${FONT}`;
    const width = Math.min(VIEW_W - 40, ctx.measureText(this.toast.text).width + 40);
    const x = (VIEW_W - width) / 2;
    const y = VIEW_H - 64;
    ctx.globalAlpha = Math.min(1, this.toast.timer * 3);
    ctx.fillStyle = COLORS.ink;
    roundRect(ctx, x, y, width, 40, 20);
    ctx.fill();
    ctx.fillStyle = COLORS.white;
    ctx.textAlign = "center";
    ctx.fillText(this.toast.text, VIEW_W / 2, y + 26);
    ctx.textAlign = "left";
    ctx.globalAlpha = 1;
  }
}

function formatTime(seconds) {
  const safe = Math.max(0, seconds);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}


/* ============================================================
   Запуск, меню и единственный игровой цикл
   ============================================================ */

const $ = (selector) => document.querySelector(selector);

const overlay = $("#overlay");
const screens = {
  loading: $("#screen-loading"),
  menu: $("#screen-menu"),
  levels: $("#screen-levels"),
  help: $("#screen-help"),
  pause: $("#screen-pause"),
  result: $("#screen-result"),
  confirm: $("#screen-confirm"),
  error: $("#screen-error")
};

const btnStart = $("#btnStart");
const btnPause = $("#btnPause");
const btnRestart = $("#btnRestart");
const btnMenu = $("#btnMenu");
const bestLabel = $("#bestLabel");

let game = null;
let selectedLevel = 0;

function showScreen(name) {
  for (const [key, element] of Object.entries(screens)) {
    element.hidden = key !== name;
  }
  overlay.hidden = !name;
  const first = name && screens[name].querySelector("button:not(:disabled)");
  if (first && document.activeElement?.tagName !== "CANVAS") first.focus({ preventScroll: true });
}

function createElement(tag, className, text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

/* ---------- Пиксельный логотип ---------- */

// Буквы нарисованы вручную по сетке 5 × 7: «#» — закрашенный пиксель
const PIXEL_FONT = {
  К: ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"],
  О: [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."],
  Т: ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."],
  С: [".####", "#....", "#....", "#....", "#....", "#....", ".####"],
  Е: ["#####", "#....", "#....", "####.", "#....", "#....", "#####"],
  И: ["#...#", "#...#", "#..##", "#.#.#", "##..#", "#...#", "#...#"],
  Я: [".####", "#...#", "#...#", ".####", "..#.#", ".#..#", "#...#"]
};

// Мордочка котика: o — рыжий, k — тёмный, w — белый
const PIXEL_CAT = [
  "o.......o",
  "oo.....oo",
  "ooooooooo",
  "okkoookko",
  "okwooowko",
  "oooowoooo",
  ".ooooooo."
];

const PIXEL_COLORS = { o: "#f0913f", k: "#1d2a5a", w: "#ffffff" };

function drawPixelLogo(canvas, pixel) {
  const words = [
    { text: "КОТО", color: "#f0913f" },
    { text: "СЕССИЯ", color: "#1d2a5a" }
  ];
  const catWidth = PIXEL_CAT[0].length + 2;
  const letters = words.reduce((sum, word) => sum + word.text.length, 0);
  const width = catWidth + letters * 6;
  const height = 8;

  canvas.width = (width + 1) * pixel;
  canvas.height = (height + 1) * pixel;
  const ctx = canvas.getContext("2d");

  const dot = (x, y, color, shadow) => {
    if (shadow) {
      ctx.fillStyle = "#9fb4ff";
      ctx.fillRect((x + 1) * pixel, (y + 1) * pixel, pixel, pixel);
    } else {
      ctx.fillStyle = color;
      ctx.fillRect(x * pixel, y * pixel, pixel, pixel);
    }
  };

  // Сначала голубая тень со сдвигом на пиксель, потом цветной слой
  for (const shadow of [true, false]) {
    PIXEL_CAT.forEach((row, y) => {
      [...row].forEach((cell, x) => {
        if (cell !== ".") dot(x, y, PIXEL_COLORS[cell], shadow);
      });
    });

    let cursor = catWidth;
    for (const word of words) {
      for (const letter of word.text) {
        PIXEL_FONT[letter].forEach((row, y) => {
          [...row].forEach((cell, x) => {
            if (cell === "#") dot(cursor + x, y, word.color, shadow);
          });
        });
        cursor += 6;
      }
    }
  }
}

/* ---------- Список пар ---------- */

function renderLevels() {
  const list = $("#levelList");
  const progress = game.progress;
  const cards = game.levels.map((def, index) => {
    const unlocked = index < progress.unlocked;
    const saved = progress.levels[String(def.id)];
    const card = createElement("button", "level-card");
    card.type = "button";
    card.disabled = !unlocked;

    let meta = `Сначала сдай пару ${index}`;
    if (unlocked) {
      if (!saved) meta = "Ещё не играл";
      else if (saved.grade) meta = `Рекорд ${saved.best} · оценка ${saved.grade}${saved.time != null ? ` · ${formatTime(saved.time)}` : ""}`;
      else meta = `Рекорд ${saved.best} · ещё не сдана`;
    }

    card.append(
      createElement("span", "level-card__num", String(index + 1).padStart(2, "0")),
      createElement("span", "level-card__title", `${def.title} · ${def.subject}`),
      createElement("span", "level-card__meta", meta)
    );
    card.addEventListener("click", () => {
      selectedLevel = index;
      game.startStory(index);
    });
    return card;
  });

  const endless = createElement("button", "level-card");
  endless.type = "button";
  endless.append(
    createElement("span", "level-card__num", "∞"),
    createElement("span", "level-card__title", "Бесконечная сессия"),
    createElement("span", "level-card__meta", progress.endlessBest
      ? `Рекорд ${progress.endlessBest} · ${progress.endlessMeters} м`
      : "Без финиша, только рекорд")
  );
  endless.addEventListener("click", () => game.startEndless());

  list.replaceChildren(...cards, endless);
}

function renderBest() {
  const progress = game.progress;
  if (game.mode === "endless" && game.state !== "menu") {
    bestLabel.textContent = `Рекорд сессии: ${progress.endlessBest || "—"}`;
    return;
  }
  const def = game.levels[game.state === "menu" ? selectedLevel : game.levelIndex];
  const saved = progress.levels[String(def.id)];
  bestLabel.textContent = `Рекорд «${def.title}»: ${saved ? saved.best : "—"}`;
}

function syncToolbar(state) {
  const running = state === "playing" || state === "qte" || state === "boss";
  btnStart.disabled = running || state === "paused" || state === "loading";
  btnPause.disabled = !(running || state === "paused");
  btnPause.textContent = state === "paused" ? "Продолжить" : "Пауза";
  btnRestart.disabled = state === "menu" || state === "loading";
  btnMenu.disabled = state === "menu" || state === "loading";
  renderBest();
}

/* ---------- Связь игры и интерфейса ---------- */

const ui = {
  onState(state) {
    document.body.dataset.state = state;
    if (state === "paused") showScreen("pause");
    else if (state === "menu") {
      renderLevels();
      showScreen("menu");
    } else if (state === "playing" || state === "qte" || state === "boss") {
      showScreen(null);
    }
    syncToolbar(state);
  },

  onResult(result) {
    $("#resultEyebrow").textContent = result.won ? "Экзамен сдан" : "Не повезло";
    $("#resultTitle").textContent = result.title;
    $("#resultText").textContent = result.text;
    $("#resultLines").replaceChildren(...result.lines.map((line) => createElement("li", "", line)));
    $("#resultScore").textContent = `${result.score} очков`;
    $("#resultBest").textContent = result.isRecord ? "· новый рекорд!" : `· рекорд ${result.best || "—"}`;
    $("#resultNext").hidden = !result.canNext;
    showScreen("result");
    syncToolbar(game.state);
  }
};

/* ---------- Кнопки ---------- */

function bindButtons() {
  btnStart.addEventListener("click", () => {
    if (game.state === "won" || game.state === "lost") game.restart();
    else game.startStory(selectedLevel);
  });
  btnPause.addEventListener("click", () => game.togglePause());
  btnRestart.addEventListener("click", () => game.restart());
  btnMenu.addEventListener("click", () => game.toMenu());

  // Во весь экран: если браузер не разрешит, просто остаёмся в окне
  $("#btnFull").addEventListener("click", async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await $(".stage").requestFullscreen();
    } catch {
      $("#btnFull").disabled = true;
    }
  });

  $("#menuPlay").addEventListener("click", () => {
    renderLevels();
    showScreen("levels");
  });
  $("#menuEndless").addEventListener("click", () => game.startEndless());
  $("#menuHelp").addEventListener("click", () => showScreen("help"));
  $("#menuReset").addEventListener("click", () => showScreen("confirm"));
  $("#confirmReset").addEventListener("click", () => {
    game.resetProgress();
    selectedLevel = 0;
    renderLevels();
    renderBest();
    showScreen("menu");
  });
  for (const back of document.querySelectorAll("[data-back]")) {
    back.addEventListener("click", () => showScreen("menu"));
  }

  $("#pauseResume").addEventListener("click", () => game.resume());
  $("#pauseRestart").addEventListener("click", () => game.restart());
  $("#pauseMenu").addEventListener("click", () => game.toMenu());

  $("#resultNext").addEventListener("click", () => {
    selectedLevel = Math.min(game.levels.length - 1, game.levelIndex + 1);
    game.startStory(selectedLevel);
  });
  $("#resultRetry").addEventListener("click", () => game.restart());
  $("#resultMenu").addEventListener("click", () => game.toMenu());
}

/* ---------- Единственный игровой цикл ---------- */

let lastFrame = null;
let rafId = null;

function frame(now) {
  if (game.isRunning()) {
    if (lastFrame === null) lastFrame = now;
    const dt = Math.min((now - lastFrame) / 1000, MAX_DT);
    lastFrame = now;
    game.update(dt);
  } else {
    // На паузе и в меню время кадра сбрасывается, чтобы после продолжения не было скачка
    lastFrame = null;
  }

  game.render(now / 1000);
  rafId = requestAnimationFrame(frame);
}

function startLoop() {
  if (rafId === null) rafId = requestAnimationFrame(frame);
}

/* ---------- Запуск ---------- */

async function loadLevels() {
  // Уровни лежат в этой же странице, в блоке <script type="application/json">.
  // Так игра открывается двойным щелчком, без сервера.
  const embedded = document.querySelector("#levels-data");
  const data = embedded ? JSON.parse(embedded.textContent) : await (await fetch("levels.json")).json();
  if (!Array.isArray(data.levels) || data.levels.length === 0) throw new Error("в данных нет уровней");
  return data.levels;
}

async function init() {
  try {
    const levels = await loadLevels();
    const input = new Input();
    game = new Game($("#game"), input, levels, ui);

    input.attach();
    input.bindButtons(document.querySelectorAll("[data-action]"));
    input.isActive = () => game.isRunning();
    input.onPauseKey = () => game.togglePause();

    selectedLevel = Math.min(levels.length - 1, game.progress.unlocked - 1);

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        input.clear();
        game.pause();
      }
    });

    drawPixelLogo($("#logoTop"), 3);
    drawPixelLogo($("#logoMenu"), 5);

    bindButtons();
    game.toMenu();
    startLoop();
  } catch (error) {
    $("#errorText").textContent = `${error.message}. Проверь блок с уровнями в конце страницы.`;
    showScreen("error");
  }
}

init();

