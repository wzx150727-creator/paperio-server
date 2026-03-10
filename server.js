const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json());
app.use((req,res,next)=>{
  res.header('Access-Control-Allow-Origin','*');
  res.header('Access-Control-Allow-Headers','Content-Type');
  res.header('Access-Control-Allow-Methods','GET,POST,OPTIONS');
  if(req.method==='OPTIONS') return res.sendStatus(200);
  next();
});

const COLS = 75, ROWS = 75;
let rooms = {};

// ── Leaderboard (top 20, in-memory) ──
let leaderboard = [];

app.get('/leaderboard', (req, res) => res.json(leaderboard));

app.post('/leaderboard', (req, res) => {
  const { name, score, skin } = req.body;
  if (!name || typeof score !== 'number') return res.status(400).json({error:'bad'});
  leaderboard.push({ name: name.slice(0,16), score: Math.round(score), skin: skin||'default', date: new Date().toISOString().slice(0,10) });
  leaderboard.sort((a,b) => b.score - a.score);
  leaderboard = leaderboard.slice(0, 20);
  res.json({ ok: true });
});

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
  return {
    id: roomId, grid: makeGrid(), players: {}, started: false, tick: 0,
    starts: [
      {x:8,y:37,dx:1,dy:0},{x:66,y:37,dx:-1,dy:0},
      {x:37,y:8,dx:0,dy:1},{x:37,y:66,dx:0,dy:-1},
    ],
  };
}

function captureTrail(room, pid) {
  const p = room.players[pid];
  if (!p || !p.trail.length) return;
  p.trail.forEach(([x,y]) => room.grid[y][x] = { owner: pid, trail: false });
  p.trail = []; p.inTrail = false;
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
  while (qi < q.length) { const x=q[qi++],y=q[qi++]; tryAdd(x+1,y);tryAdd(x-1,y);tryAdd(x,y+1);tryAdd(x,y-1); }
  for (let y=0;y<ROWS;y++) for (let x=0;x<COLS;x++)
    if (!outside[y*COLS+x]) room.grid[y][x] = { owner: pid, trail: false };
}

function getScore(room, pid) {
  let c=0;
  for (let y=0;y<ROWS;y++) for (let x=0;x<COLS;x++) if (room.grid[y][x]?.owner===pid) c++;
  return Math.round(c/(COLS*ROWS)*100);
}

function killPlayer(room, pid, killer) {
  const p = room.players[pid];
  if (!p || !p.alive) return;
  p.alive = false;
  p.trail.forEach(([x,y]) => room.grid[y][x] = null); p.trail = [];
  if (killer && killer !== pid)
    for (let y=0;y<ROWS;y++) for (let x=0;x<COLS;x++)
      if (room.grid[y][x]?.owner === pid) room.grid[y][x] = { owner: killer, trail: false };
  const score = getScore(room, pid);
  io.to(room.id).emit('playerDied', { pid, killer, score });
  const alive = Object.values(room.players).filter(p => p.alive);
  if (alive.length <= 1) {
    const winner = alive[0];
    io.to(room.id).emit('gameOver', { winner: winner?.id||null, score: winner?getScore(room,winner.id):0 });
    clearInterval(room.interval);
  }
}

function tickRoom(room) {
  room.tick++;
  const ps = Object.values(room.players).filter(p => p.alive);
  ps.forEach(p => {
    const {ndx,ndy,dx,dy} = p;
    if (!(ndx===-dx&&ndy===-dy)) { p.dx=ndx; p.dy=ndy; }
    let nx=p.x+p.dx, ny=p.y+p.dy;
    if (nx<0){nx=0;p.dx=0;p.ndx=0;} if (nx>=COLS){nx=COLS-1;p.dx=0;p.ndx=0;}
    if (ny<0){ny=0;p.dy=0;p.ndy=0;} if (ny>=ROWS){ny=ROWS-1;p.dy=0;p.ndy=0;}
    if (p.inTrail && p.trail.some(([tx,ty])=>tx===nx&&ty===ny)) { killPlayer(room,p.id,'self'); return; }
    p.x=nx; p.y=ny;
    const cell = room.grid[ny][nx];
    const onOwn = cell?.owner===p.id && !cell?.trail;
    ps.forEach(o => { if (o.id===p.id||!o.alive||!o.inTrail) return; if (o.trail.some(([tx,ty])=>tx===nx&&ty===ny)) killPlayer(room,o.id,p.id); });
    if (onOwn && p.inTrail) { captureTrail(room, p.id); return; }
    if (!onOwn) { p.inTrail=true; room.grid[ny][nx]={owner:p.id,trail:true}; p.trail.push([nx,ny]); }
  });
  io.to(room.id).emit('state', {
    players: Object.fromEntries(Object.entries(room.players).map(([id,p])=>
      [id,{x:p.x,y:p.y,dx:p.dx,dy:p.dy,alive:p.alive,inTrail:p.inTrail,colorIdx:p.colorIdx}])),
    grid: room.grid,
  });
}

io.on('connection', socket => {
  socket.on('joinRoom', ({ roomId }) => {
    let room = rooms[roomId];
    if (!room) { room = createRoom(roomId); rooms[roomId] = room; }
    const count = Object.keys(room.players).length;
    if (count >= 4 || room.started) { socket.emit('roomFull'); return; }
    const s = room.starts[count];
    room.players[socket.id] = { id:socket.id, x:s.x, y:s.y, dx:s.dx, dy:s.dy, ndx:s.dx, ndy:s.dy, trail:[], inTrail:false, alive:true, colorIdx:count };
    fill(room.grid, s.x, s.y, 3, socket.id);
    socket.join(roomId); socket.data.roomId = roomId;
    socket.emit('joined', { pid:socket.id, colorIdx:count, grid:room.grid, players:room.players });
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
    if (Object.keys(room.players).length === 0) { clearInterval(room.interval); delete rooms[socket.data.roomId]; }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server on port', PORT));
