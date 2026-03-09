const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const COLS = 75, ROWS = 75;
const COLORS = ['#4d96ff','#ff6b6b','#6bcb77','#ffd93d'];
const TRAIL_COLORS = ['#1a4fa8','#9e1a1a','#1a7a28','#9a7200'];

let rooms = {};

function makeGrid() {
  return Array.from({length: ROWS}, () => new Array(COLS).fill(null));
}

function inBounds(x, y) { return x>=0&&x<COLS&&y>=0&&y<ROWS; }

function fill(grid, cx, cy, r, id) {
  for (let dy=-r; dy<=r; dy++)
    for (let dx=-r; dx<=r; dx++) {
      const x=cx+dx, y=cy+dy;
      if (inBounds(x,y)) grid[y][x] = { owner: id, trail: false };
    }
}

function createRoom(roomId) {
  const starts = [
    {x:8,  y:37, dx:1,  dy:0},
    {x:66, y:37, dx:-1, dy:0},
    {x:37, y:8,  dx:0,  dy:1},
    {x:37, y:66, dx:0,  dy:-1},
  ];
  return {
    id: roomId,
    grid: makeGrid(),
    players: {},
    started: false,
    tick: 0,
    starts,
  };
}

function captureTrail(room, pid) {
  const p = room.players[pid];
  if (!p || !p.trail.length) return;
  p.trail.forEach(([x,y]) => room.grid[y][x] = { owner: pid, trail: false });
  p.trail = [];
  p.inTrail = false;

  const outside = new Uint8Array(COLS * ROWS);
  const q = [];
  function tryAdd(x, y) {
    const k = y*COLS+x;
    if (!inBounds(x,y) || outside[k]) return;
    const c = room.grid[y][x];
    if (c && c.owner === pid && !c.trail) return;
    outside[k] = 1; q.push(x, y);
  }
  for (let x=0;x<COLS;x++) { tryAdd(x,0); tryAdd(x,ROWS-1); }
  for (let y=0;y<ROWS;y++) { tryAdd(0,y); tryAdd(COLS-1,y); }
  let qi = 0;
  while (qi < q.length) {
    const x=q[qi++], y=q[qi++];
    tryAdd(x+1,y); tryAdd(x-1,y); tryAdd(x,y+1); tryAdd(x,y-1);
  }
  for (let y=0;y<ROWS;y++)
    for (let x=0;x<COLS;x++)
      if (!outside[y*COLS+x]) room.grid[y][x] = { owner: pid, trail: false };
}

function killPlayer(room, pid, killer) {
  const p = room.players[pid];
  if (!p || !p.alive) return;
  p.alive = false;
  p.trail.forEach(([x,y]) => room.grid[y][x] = null);
  p.trail = [];
  // give territory to killer
  if (killer && killer !== pid) {
    for (let y=0;y<ROWS;y++)
      for (let x=0;x<COLS;x++)
        if (room.grid[y][x]?.owner === pid)
          room.grid[y][x] = { owner: killer, trail: false };
  }
  io.to(room.id).emit('playerDied', { pid, killer });
  // check win
  const alive = Object.values(room.players).filter(p => p.alive);
  if (alive.length === 1) {
    io.to(room.id).emit('gameOver', { winner: alive[0].id });
    clearInterval(room.interval);
  }
}

function tickRoom(room) {
  room.tick++;
  const ps = Object.values(room.players).filter(p => p.alive);

  ps.forEach(p => {
    // apply direction
    const {ndx,ndy,dx,dy} = p;
    if (!(ndx===-dx&&ndy===-dy)) { p.dx=ndx; p.dy=ndy; }
    let nx=p.x+p.dx, ny=p.y+p.dy;
    if (nx<0){nx=0;p.dx=1;p.ndx=1;}
    if (nx>=COLS){nx=COLS-1;p.dx=-1;p.ndx=-1;}
    if (ny<0){ny=0;p.dy=1;p.ndy=1;}
    if (ny>=ROWS){ny=ROWS-1;p.dy=-1;p.ndy=-1;}

    // self trail collision
    if (p.inTrail && p.trail.some(([tx,ty])=>tx===nx&&ty===ny)) {
      killPlayer(room, p.id, 'self'); return;
    }

    p.x=nx; p.y=ny;
    const cell = room.grid[ny][nx];
    const onOwn = cell?.owner===p.id && !cell?.trail;

    // cut enemy trails
    ps.forEach(o => {
      if (o.id===p.id||!o.alive||!o.inTrail) return;
      if (o.trail.some(([tx,ty])=>tx===nx&&ty===ny)) killPlayer(room,o.id,p.id);
    });

    if (onOwn && p.inTrail) { captureTrail(room, p.id); return; }
    if (!onOwn) {
      p.inTrail=true;
      room.grid[ny][nx]={owner:p.id,trail:true};
      p.trail.push([nx,ny]);
    }
  });

  // broadcast state
  io.to(room.id).emit('state', {
    players: Object.fromEntries(Object.entries(room.players).map(([id,p])=>
      [id,{x:p.x,y:p.y,dx:p.dx,dy:p.dy,alive:p.alive,inTrail:p.inTrail,colorIdx:p.colorIdx}]
    )),
    grid: room.grid,
  });
}

io.on('connection', socket => {
  console.log('connected:', socket.id);

  socket.on('joinRoom', ({ roomId }) => {
    let room = rooms[roomId];
    if (!room) { room = createRoom(roomId); rooms[roomId] = room; }

    const count = Object.keys(room.players).length;
    if (count >= 4 || room.started) { socket.emit('roomFull'); return; }

    const s = room.starts[count];
    room.players[socket.id] = {
      id: socket.id,
      x: s.x, y: s.y,
      dx: s.dx, dy: s.dy,
      ndx: s.dx, ndy: s.dy,
      trail: [], inTrail: false,
      alive: true,
      colorIdx: count,
    };
    fill(room.grid, s.x, s.y, 3, socket.id);
    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.emit('joined', {
      pid: socket.id,
      colorIdx: count,
      grid: room.grid,
      players: room.players,
    });
    io.to(roomId).emit('playerJoined', { count: count+1 });
  });

  socket.on('startGame', () => {
    const room = rooms[socket.data.roomId];
    if (!room || room.started) return;
    room.started = true;
    io.to(room.id).emit('gameStarted');
    room.interval = setInterval(() => tickRoom(room), 1000/15);
  });

  socket.on('dir', ({ dx, dy }) => {
    const room = rooms[socket.data.roomId];
    const p = room?.players[socket.id];
    if (!p || !p.alive) return;
    p.ndx = dx; p.ndy = dy;
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.data.roomId];
    if (!room) return;
    killPlayer(room, socket.id, null);
    delete room.players[socket.id];
    if (Object.keys(room.players).length === 0) {
      clearInterval(room.interval);
      delete rooms[socket.data.roomId];
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server running on port', PORT));
