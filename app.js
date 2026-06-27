/* ================================================================
   DEVDOME — APP LOGIC (Supabase-backed)
   This file replaces every in-memory array from the prototype with
   real database calls. Nothing in here persists "in the browser" —
   it all lives in your Supabase project, so it works across any
   number of tabs, browsers, or devices, with your PC off.
================================================================ */

// ─── SUPABASE CONFIG ────────────────────────────────────────────
// Project URL is your Supabase project ref + .supabase.co
// (find both of these in: Supabase Dashboard → Project Settings → API)
const SUPABASE_URL = "https://girymwguhtntkabtljdq.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_r2G7bQcGrHyNik8uRUB7Fw_f3RetYzT";

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* ─── BIOMES ─────────────────────────────────────────────────── */
const BIOMES = {
  forest:['#1d3b2a','#2f5d3f','#4a8a5a','#1a2e1f','#3d7a4d','#234d31'],
  desert:['#7a5a2c','#caa14d','#8c6a35','#3d2e16','#b88c3c','#5c4420'],
  cave:  ['#2a2a33','#46465a','#1a1a22','#5c5c75','#38384a','#2e2e3c'],
  ocean: ['#0e3a4a','#1f6e85','#0a2530','#3aa8c2','#155e75','#0d2e3c'],
  nether:['#4a1212','#7a1f1f','#2b0a0a','#a83a1f','#6b1a1a','#3d0e0e'],
  tundra:['#2a3a4a','#4a6a8a','#c8dce8','#8aaabf','#364d60','#1a2836'],
};

const AVATAR_COLORS = [
  'linear-gradient(135deg,#38bdf8,#ff7a3d)',
  'linear-gradient(135deg,#10b981,#38bdf8)',
  'linear-gradient(135deg,#a78bfa,#ff7a3d)',
  'linear-gradient(135deg,#f59e0b,#10b981)',
  'linear-gradient(135deg,#ff7a3d,#a78bfa)',
];
function colorIdxFor(str){
  if(!str) return 0;
  let h=0; for(let i=0;i<str.length;i++) h=(h*31+str.charCodeAt(i))|0;
  return Math.abs(h)%AVATAR_COLORS.length;
}

/* ─── APP STATE (cache of what's in the DB, refreshed live) ──── */
let session = null;        // supabase auth session
let profile = null;        // { id, username, skills }
let profileCache = {};     // id -> {username}, filled as we encounter authors

let pitches = [];          // [{...pitch, votesPlay, votesHelp, myVotePlay, myVoteHelp}]
let squadPosts = [];        // [{...squad, joinRequests:[...]}]
let chatThreads = [];       // [{...thread, messages:[...], unread}]
let activeChatId = null;

let selectedBiome = "forest";
let activeTag = null;
let editingUsername = false;

/* ─── UTILS ───────────────────────────────────────────────────── */
function esc(s){ return String(s||'').replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

function toast(msg, type='default'){
  const wrap = document.getElementById('toastWrap');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  wrap.appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; el.style.transition='opacity .3s'; setTimeout(()=>el.remove(),300); }, 3500);
}

function updateCharCount(el, countId, max){
  const left = max - el.value.length;
  const el2 = document.getElementById(countId);
  if(el2){ el2.textContent = left + ' left'; el2.style.color = left < 20 ? 'var(--danger)' : 'var(--text-faint)'; }
}

function requireAuth(cb){
  if(session){ cb(); return; }
  openModal('authOverlay');
  toast('Sign in first to do that.','warn');
}

function openModal(id){ document.getElementById(id).hidden = false; }
function closeModal(id){ document.getElementById(id).hidden = true; }

document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>closeModal(b.dataset.close)));
document.querySelectorAll('.overlay').forEach(o=>o.addEventListener('click',e=>{ if(e.target===o) o.hidden=true; }));
document.addEventListener('keydown', e=>{ if(e.key==='Escape') document.querySelectorAll('.overlay:not([hidden])').forEach(o=>o.hidden=true); });

function usernameFor(id){
  if(profile && profile.id===id) return profile.username;
  return profileCache[id] || id.slice(0,8);
}

async function ensureProfilesCached(ids){
  const missing = [...new Set(ids)].filter(id=>id && !profileCache[id] && !(profile&&profile.id===id));
  if(!missing.length) return;
  const { data, error } = await sb.from('profiles').select('id,username').in('id', missing);
  if(error){ console.error(error); return; }
  (data||[]).forEach(p=>profileCache[p.id]=p.username);
}

/* ─── TABS ────────────────────────────────────────────────────── */
function switchTab(tab){
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.toggle('active',b.dataset.tab===tab));
  ['forge','squad','chat','profile'].forEach(n=>document.getElementById('page-'+n).hidden=(n!==tab));
  if(tab==='profile') renderProfile();
  if(tab==='chat') renderChat();
}
document.querySelectorAll('.tab-btn').forEach(btn=>btn.addEventListener('click',()=>switchTab(btn.dataset.tab)));
document.getElementById('searchInput').addEventListener('input', renderPitches);
document.getElementById('sortSelect').addEventListener('change', renderPitches);
document.getElementById('squadSearch').addEventListener('input', renderSquad);

/* ─── AUTH ────────────────────────────────────────────────────── */
let authMode = 'signin';

function switchAuthTab(mode){
  authMode = mode;
  document.getElementById('signinTab').classList.toggle('active', mode==='signin');
  document.getElementById('signupTab').classList.toggle('active', mode==='signup');
  document.getElementById('usernameField').hidden = (mode==='signin');
  document.getElementById('authSubmitBtn').textContent = mode==='signin' ? 'Sign in' : 'Create account';
  document.getElementById('authTitle').textContent = mode==='signin' ? 'Sign in to DevDome' : 'Join DevDome';
}
document.getElementById('signinTab').addEventListener('click',()=>switchAuthTab('signin'));
document.getElementById('signupTab').addEventListener('click',()=>switchAuthTab('signup'));

async function handleOAuth(provider){
  const { error } = await sb.auth.signInWithOAuth({
    provider,
    options: { redirectTo: window.location.href }
  });
  if(error){ toast(error.message,'warn'); return; }
  // Browser will redirect to provider, then back here — onAuthStateChange picks it up.
}
document.getElementById('githubOauthBtn').addEventListener('click',()=>handleOAuth('github'));
document.getElementById('googleOauthBtn').addEventListener('click',()=>handleOAuth('google'));

async function handleAuth(){
  const email = document.getElementById('authEmail').value.trim();
  const pass = document.getElementById('authPassword').value;
  const usernameRaw = document.getElementById('authUsername').value.trim();
  const username = usernameRaw.replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_]/g,'');

  if(!email||!pass){ toast('Enter email and password.','warn'); return; }
  if(authMode==='signup'&&!username){ toast('Pick a username.','warn'); return; }
  if(authMode==='signup'&&username.length<2){ toast('Username must be at least 2 characters.','warn'); return; }

  const btn = document.getElementById('authSubmitBtn');
  btn.disabled = true;

  if(authMode==='signin'){
    const { error } = await sb.auth.signInWithPassword({ email, password: pass });
    btn.disabled = false;
    if(error){ toast(error.message,'warn'); return; }
    closeModal('authOverlay');
    toast('Signed in! Good to have you back.', 'success');
  } else {
    const { data, error } = await sb.auth.signUp({
      email, password: pass,
      options: { data: { username } }
    });
    btn.disabled = false;
    if(error){
      if(/duplicate|unique/i.test(error.message)) toast('That username is taken — try another.','warn');
      else toast(error.message,'warn');
      return;
    }
    closeModal('authOverlay');
    if(data.session){
      toast('Account created! Welcome to DevDome 🎮', 'success');
    } else {
      toast('Check your email to confirm your account, then sign in.', 'info');
      switchAuthTab('signin');
    }
  }
}
document.getElementById('authSubmitBtn').addEventListener('click',handleAuth);

async function handleSignout(){
  await sb.auth.signOut();
  activeChatId = null;
  editingUsername = false;
  closeModal('settingsOverlay');
  toast('Signed out. Come back soon!','info');
  switchTab('forge');
}
document.getElementById('signOutBtn').addEventListener('click',handleSignout);

document.getElementById('loginBtn').addEventListener('click',()=>{
  if(session) switchTab('profile');
  else openModal('authOverlay');
});

function applyAuthUI(){
  const loginBtn = document.getElementById('loginBtn');
  if(session && profile){
    loginBtn.textContent = '@' + profile.username;
  } else {
    loginBtn.textContent = 'Sign In';
  }
}

/* ─── USERNAME EDITING ────────────────────────────────────────── */
function renderProfileNameArea(){
  const area = document.getElementById('profileNameArea');
  if(!session || !profile){ area.innerHTML = '<div class="profile-name">Not signed in</div>'; return; }

  if(editingUsername){
    area.innerHTML = `
      <div class="username-edit-wrap">
        <input class="username-input" id="usernameEditInput" value="${esc(profile.username)}" maxlength="30" placeholder="your_name" spellcheck="false">
        <button class="save-username-btn" id="saveUsernameBtn">Save</button>
        <button class="cancel-username-btn" id="cancelUsernameBtn">Cancel</button>
      </div>`;
    setTimeout(()=>{ const el=document.getElementById('usernameEditInput'); if(el){el.focus();el.select();} },50);
    document.getElementById('usernameEditInput').addEventListener('keydown',e=>{
      if(e.key==='Enter') saveUsername();
      if(e.key==='Escape') cancelUsernameEdit();
    });
    document.getElementById('saveUsernameBtn').addEventListener('click',saveUsername);
    document.getElementById('cancelUsernameBtn').addEventListener('click',cancelUsernameEdit);
  } else {
    area.innerHTML = `
      <div class="profile-name-wrap">
        <div class="profile-name">${esc(profile.username)}</div>
        <button class="edit-name-btn" id="editNameBtn">✏ Edit username</button>
      </div>`;
    document.getElementById('editNameBtn').addEventListener('click',()=>{ editingUsername=true; renderProfileNameArea(); });
  }
}

function startUsernameEdit(){ editingUsername = true; renderProfileNameArea(); }
function cancelUsernameEdit(){ editingUsername = false; renderProfileNameArea(); }

async function saveUsername(){
  const input = document.getElementById('usernameEditInput');
  if(!input) return;
  const raw = input.value.trim().replace(/\s+/g,'_').replace(/[^a-zA-Z0-9_]/g,'');
  if(!raw){ toast('Username can only contain letters, numbers, and underscores.','warn'); return; }
  if(raw.length < 2){ toast('Username must be at least 2 characters.','warn'); return; }

  const { error } = await sb.from('profiles').update({ username: raw }).eq('id', profile.id);
  if(error){
    if(/duplicate|unique/i.test(error.message)) toast('That username is taken.','warn');
    else toast(error.message,'warn');
    return;
  }
  profile.username = raw;
  document.getElementById('profileHandle').textContent = '@' + raw;
  editingUsername = false;
  applyAuthUI();
  renderProfileNameArea();
  toast('Username updated to @' + raw, 'success');
}

/* ─── VOXEL THUMB ─────────────────────────────────────────────── */
function voxelThumb(biome, seed='x'){
  const colors = BIOMES[biome] || BIOMES.forest;
  const cols=14, rows=5;
  let cells='';
  for(let i=0;i<cols*rows;i++){
    const n = Math.abs(Math.sin(i*12.9898 + seed.length*4.1414 + 0.1));
    const c = colors[Math.floor(n*colors.length)%colors.length];
    cells += `<div style="background:${c}"></div>`;
  }
  return `<div class="voxel-thumb" style="display:grid;grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr);">${cells}</div>`;
}

/* ─── DATA: PITCHES ───────────────────────────────────────────── */
async function loadPitches(){
  const { data: pitchRows, error } = await sb
    .from('pitches')
    .select('*')
    .order('created_at', { ascending: false });
  if(error){ console.error(error); toast('Could not load pitches.','warn'); return; }

  const { data: voteRows, error: vErr } = await sb.from('votes').select('*');
  if(vErr){ console.error(vErr); }

  await ensureProfilesCached(pitchRows.map(p=>p.author_id));

  pitches = pitchRows.map(p=>{
    const myId = profile ? profile.id : null;
    const votesForPitch = (voteRows||[]).filter(v=>v.pitch_id===p.id);
    return {
      id: p.id,
      title: p.title,
      desc: p.description,
      tags: p.tags || [],
      biome: p.biome,
      author: p.author_id,
      authorName: usernameFor(p.author_id),
      createdAt: new Date(p.created_at).getTime(),
      mine: myId === p.author_id,
      votesPlay: votesForPitch.filter(v=>v.kind==='play').length,
      votesHelp: votesForPitch.filter(v=>v.kind==='help').length,
      myVotePlay: myId ? votesForPitch.some(v=>v.kind==='play'&&v.user_id===myId) : false,
      myVoteHelp: myId ? votesForPitch.some(v=>v.kind==='help'&&v.user_id===myId) : false,
    };
  });
  renderChips();
  renderPitches();
}

/* ─── TAG FILTER ──────────────────────────────────────────────── */
function allTags(){
  const s=new Set();
  pitches.forEach(p=>p.tags.forEach(t=>s.add(t)));
  return [...s].sort();
}
function renderChips(){
  const wrap = document.getElementById('tagChips');
  wrap.innerHTML = allTags().map(t=>`<button class="chip ${activeTag===t?'on':''}" data-tag="${esc(t)}">#${esc(t)}</button>`).join('');
  wrap.querySelectorAll('.chip').forEach(c=>{
    c.addEventListener('click',()=>{ activeTag = activeTag===c.dataset.tag?null:c.dataset.tag; renderChips(); renderPitches(); });
  });
}

/* ─── PITCH LIST ──────────────────────────────────────────────── */
function filteredPitches(){
  const q = (document.getElementById('searchInput')||{value:''}).value.toLowerCase();
  const sort = (document.getElementById('sortSelect')||{value:'hot'}).value;
  let list = pitches.filter(p=>{
    if(activeTag && !p.tags.includes(activeTag)) return false;
    if(q && !p.title.toLowerCase().includes(q) && !p.desc.toLowerCase().includes(q) && !p.tags.join(' ').toLowerCase().includes(q)) return false;
    return true;
  });
  if(sort==='hot') list.sort((a,b)=>(b.votesPlay+b.votesHelp)-(a.votesPlay+a.votesHelp));
  else if(sort==='new') list.sort((a,b)=>b.createdAt-a.createdAt);
  else list.sort((a,b)=>b.votesHelp-a.votesHelp);
  return list;
}

function renderPitches(){
  const grid = document.getElementById('pitchGrid');
  const list = filteredPitches();
  document.getElementById('pitchCount').textContent = pitches.length;
  if(!list.length){
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1;"><div class="emoji">🔭</div><h3>No pitches match that filter</h3><p>Try a different tag or be the first to post in this category.</p></div>`;
    return;
  }
  grid.innerHTML = list.map((p)=>{
    const thumbBadge = (Date.now()-p.createdAt < 60000*10) ? '<span class="thumb-badge new-post">New</span>' : '';
    return `
      <article class="card">
        <div style="position:relative;">
          ${voxelThumb(p.biome,p.title)}
          ${thumbBadge}
        </div>
        <div class="card-body">
          <div class="card-title">${esc(p.title)}</div>
          <div class="card-desc">${esc(p.desc)}</div>
          <div class="card-tags">${p.tags.map(t=>`<span class="tag">#${esc(t)}</span>`).join('')}</div>
          <div class="card-foot">
            <div class="vote-btns">
              <button class="vote-btn play ${p.myVotePlay?'on':''}" data-id="${p.id}" data-kind="play" title="I want to play this">🔥 ${p.votesPlay}</button>
              <button class="vote-btn help ${p.myVoteHelp?'on':''}" data-id="${p.id}" data-kind="help" title="I can help build this">🛠 ${p.votesHelp}</button>
            </div>
            <div class="card-author">@${esc(p.authorName)}</div>
          </div>
        </div>
      </article>`;
  }).join('');
  grid.querySelectorAll('.vote-btn').forEach(btn=>{
    btn.addEventListener('click',()=>requireAuth(()=>castVote(+btn.dataset.id, btn.dataset.kind)));
  });
}

async function castVote(id, kind){
  const p = pitches.find(x=>x.id===id);
  if(!p) return;
  const currentlyOn = kind==='play' ? p.myVotePlay : p.myVoteHelp;

  if(currentlyOn){
    const { error } = await sb.from('votes').delete()
      .eq('pitch_id', id).eq('user_id', profile.id).eq('kind', kind);
    if(error){ toast(error.message,'warn'); return; }
  } else {
    const { error } = await sb.from('votes').insert({ pitch_id: id, user_id: profile.id, kind });
    if(error){ toast(error.message,'warn'); return; }
    toast(kind==='play' ? '🔥 Voted "want to play"!' : '🛠 Voted "can help build"!', kind==='play'?'default':'info');
  }
  await loadPitches();
  renderProfile();
}

/* ─── SUBMIT PITCH ────────────────────────────────────────────── */
function renderBiomeSwatches(){
  const wrap = document.getElementById('biomeSwatches');
  wrap.innerHTML = Object.keys(BIOMES).map(b=>`
    <div style="text-align:center;display:flex;flex-direction:column;align-items:center;gap:6px;">
      <div class="swatch ${b===selectedBiome?'sel':''}" data-biome="${b}" style="background:linear-gradient(135deg,${BIOMES[b][0]},${BIOMES[b][1]});" title="${b}"></div>
      <div style="font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--text-faint);">${b}</div>
    </div>
  `).join('');
  wrap.querySelectorAll('.swatch').forEach(sw=>{
    sw.addEventListener('click',()=>{ selectedBiome=sw.dataset.biome; renderBiomeSwatches(); });
  });
}

document.getElementById('newPitchBtn').addEventListener('click',()=>requireAuth(()=>{ renderBiomeSwatches(); openModal('pitchOverlay'); }));
['pitchTitle'].forEach(id=>document.getElementById(id).addEventListener('input',e=>updateCharCount(e.target,'pitchTitleCount',60)));
document.getElementById('pitchDesc').addEventListener('input',e=>updateCharCount(e.target,'pitchDescCount',220));

document.getElementById('submitPitch').addEventListener('click', async ()=>{
  const title = document.getElementById('pitchTitle').value.trim();
  const desc = document.getElementById('pitchDesc').value.trim();
  const tags = document.getElementById('pitchTags').value.split(',').map(t=>t.trim()).filter(Boolean);
  if(!title||!desc){ toast('Add a title and gameplay loop first.','warn'); return; }

  const btn = document.getElementById('submitPitch');
  btn.disabled = true;
  const { error } = await sb.from('pitches').insert({
    title, description: desc, tags: tags.length?tags:['Untagged'],
    biome: selectedBiome, author_id: profile.id
  });
  btn.disabled = false;
  if(error){ toast(error.message,'warn'); return; }

  ['pitchTitle','pitchDesc','pitchTags'].forEach(id=>document.getElementById(id).value='');
  closeModal('pitchOverlay');
  await loadPitches();
  renderProfile();
  toast('Pitch posted to the Concept Forge 🔥','success');
});

/* ─── DATA: SQUAD POSTS + JOIN REQUESTS ──────────────────────── */
async function loadSquad(){
  const { data: squadRows, error } = await sb
    .from('squad_posts').select('*').order('created_at', { ascending:false });
  if(error){ console.error(error); toast('Could not load squad posts.','warn'); return; }

  // Only requests the current user is allowed to see come back (RLS):
  // either their own requests, or requests on posts they own.
  const { data: reqRows, error: rErr } = session
    ? await sb.from('join_requests').select('*')
    : { data: [], error: null };
  if(rErr) console.error(rErr);

  await ensureProfilesCached([
    ...squadRows.map(s=>s.author_id),
    ...(reqRows||[]).map(r=>r.requester_id)
  ]);

  const myId = profile ? profile.id : null;
  squadPosts = squadRows.map(s=>({
    id: s.id,
    role: s.role,
    gameType: s.game_type,
    desc: s.description,
    skills: s.skills || [],
    author: s.author_id,
    authorName: usernameFor(s.author_id),
    mine: myId === s.author_id,
    joinRequests: (reqRows||[])
      .filter(r=>r.squad_id===s.id)
      .map(r=>({ requesterId: r.requester_id, requesterName: usernameFor(r.requester_id), status: r.status }))
  }));
  renderSquad();
}

function miniAvatar(name){
  const initials = (name||'?').slice(0,2).toUpperCase();
  const idx = colorIdxFor(name);
  return `<div style="width:22px;height:22px;flex-shrink:0;clip-path:polygon(20% 0%,100% 0%,100% 80%,80% 100%,0% 100%,0% 20%);display:flex;align-items:center;justify-content:center;font-family:'Chakra Petch',sans-serif;font-weight:700;font-size:9px;color:#0d1117;background:${AVATAR_COLORS[idx]};">${esc(initials)}</div>`;
}

function renderSquad(){
  const wrap = document.getElementById('squadList');
  const q = (document.getElementById('squadSearch')||{value:''}).value.toLowerCase();
  const list = squadPosts.filter(s=>{
    if(!q) return true;
    return s.role.toLowerCase().includes(q)||s.gameType.toLowerCase().includes(q)||s.skills.join(' ').toLowerCase().includes(q);
  });
  document.getElementById('squadCount').textContent = squadPosts.length;

  if(!list.length){
    wrap.innerHTML = `<div class="empty-state"><div class="emoji">🤝</div><h3>No squad posts yet</h3><p>Be the first to post a role you need.</p></div>`;
    return;
  }

  wrap.innerHTML = list.map(s=>{
    const isMine = s.mine;
    const myId = profile ? profile.id : null;
    const myReq = myId ? s.joinRequests.find(r=>r.requesterId===myId) : null;

    let actionBtn = '';
    if(!isMine){
      if(!myReq){
        actionBtn = `<button class="req-btn" data-id="${s.id}">Request to Join</button>`;
      } else if(myReq.status==='pending'){
        actionBtn = `<button class="req-btn sent" disabled>⏳ Pending</button>`;
      } else if(myReq.status==='accepted'){
        actionBtn = `<button class="req-btn accepted-btn" data-openchat="${s.id}">💬 Chat</button>`;
      } else {
        actionBtn = `<button class="req-btn" style="background:transparent;border:1px solid var(--border-soft);color:var(--text-faint);box-shadow:none;cursor:default;" disabled>Declined</button>`;
      }
    }

    let requestsPanel = '';
    if(isMine && s.joinRequests.length > 0){
      const rows = s.joinRequests.map(r=>{
        let statusBadge = `<span class="req-status ${r.status}">${r.status}</span>`;
        let actions = '';
        if(r.status==='pending'){
          actions = `
            <div class="req-actions">
              <button class="accept-btn" data-squad="${s.id}" data-req="${r.requesterId}">Accept</button>
              <button class="reject-btn" data-squad="${s.id}" data-req="${r.requesterId}">Decline</button>
            </div>`;
        } else if(r.status==='accepted'){
          actions = `<button class="accept-btn" style="background:var(--cyan);color:#0a1929;" data-openchat="${s.id}">💬 Open Chat</button>`;
        }
        return `
          <div class="request-row">
            <div style="display:flex;align-items:center;gap:8px;">
              ${miniAvatar(r.requesterName)}
              <span class="req-user">@${esc(r.requesterName)}</span>
              ${statusBadge}
            </div>
            ${actions}
          </div>`;
      }).join('');
      const pending = s.joinRequests.filter(r=>r.status==='pending').length;
      requestsPanel = `
        <div class="requests-panel">
          <div class="requests-label">Join Requests ${pending > 0 ? `· <span style="color:var(--ember)">${pending} pending</span>` : ''}</div>
          ${rows}
        </div>`;
    } else if(isMine) {
      requestsPanel = `<div class="requests-panel"><div class="requests-label">No requests yet</div></div>`;
    }

    return `
      <div class="squad-card">
        <div class="role-badge">${esc(s.role)}</div>
        <div class="squad-main" style="width:100%;">
          <div class="squad-head">${esc(s.gameType)}</div>
          <div class="squad-desc">${esc(s.desc)}</div>
          <div class="squad-meta">${s.skills.map(t=>'#'+esc(t)).join(' · ')} &nbsp;·&nbsp; posted by @${esc(s.authorName)}</div>
          ${requestsPanel}
        </div>
        ${!isMine ? `<div class="squad-actions">${actionBtn}</div>` : ''}
      </div>`;
  }).join('');

  wrap.querySelectorAll('.req-btn[data-id]').forEach(btn=>{
    btn.addEventListener('click',()=>requireAuth(()=>sendJoinRequest(+btn.dataset.id)));
  });
  wrap.querySelectorAll('[data-openchat]').forEach(btn=>{
    btn.addEventListener('click',()=>openChatForSquad(+btn.dataset.openchat));
  });
  wrap.querySelectorAll('.accept-btn[data-squad]').forEach(btn=>{
    btn.addEventListener('click',()=>acceptJoinRequest(+btn.dataset.squad, btn.dataset.req));
  });
  wrap.querySelectorAll('.reject-btn[data-squad]').forEach(btn=>{
    btn.addEventListener('click',()=>rejectJoinRequest(+btn.dataset.squad, btn.dataset.req));
  });
}

async function sendJoinRequest(squadId){
  const s = squadPosts.find(x=>x.id===squadId);
  if(!s) return;
  const { error } = await sb.from('join_requests').insert({ squad_id: squadId, requester_id: profile.id, status:'pending' });
  if(error){ toast(error.message,'warn'); return; }
  await loadSquad();
  toast(`Request sent to @${s.authorName} for "${s.role}" 🎉`,'success');
}

async function acceptJoinRequest(squadId, requesterId){
  const s = squadPosts.find(x=>x.id===squadId);
  if(!s) return;
  const { error } = await sb.from('join_requests')
    .update({ status:'accepted' })
    .eq('squad_id', squadId).eq('requester_id', requesterId);
  if(error){ toast(error.message,'warn'); return; }

  await createChatThread(squadId, profile.id, requesterId);
  await loadSquad();
  await loadChatThreads();
  toast(`@${usernameFor(requesterId)} accepted! A chat channel is now open. 💬`,'success');
}

async function rejectJoinRequest(squadId, requesterId){
  const { error } = await sb.from('join_requests')
    .update({ status:'rejected' })
    .eq('squad_id', squadId).eq('requester_id', requesterId);
  if(error){ toast(error.message,'warn'); return; }
  await loadSquad();
  toast(`@${usernameFor(requesterId)}'s request declined.`);
}

document.getElementById('newSquadBtn').addEventListener('click',()=>requireAuth(()=>openModal('squadOverlay')));
document.getElementById('squadDesc').addEventListener('input',e=>updateCharCount(e.target,'squadDescCount',250));

document.getElementById('submitSquad').addEventListener('click', async ()=>{
  const role = document.getElementById('squadRole').value.trim();
  const gameType = document.getElementById('squadGameType').value.trim();
  const desc = document.getElementById('squadDesc').value.trim();
  const skills = document.getElementById('squadSkills').value.split(',').map(t=>t.trim()).filter(Boolean);
  if(!role||!gameType||!desc){ toast('Fill in role, game type, and description.','warn'); return; }

  const btn = document.getElementById('submitSquad');
  btn.disabled = true;
  const { error } = await sb.from('squad_posts').insert({
    role, game_type: gameType, description: desc,
    skills: skills.length?skills:['General'], author_id: profile.id
  });
  btn.disabled = false;
  if(error){ toast(error.message,'warn'); return; }

  ['squadRole','squadGameType','squadDesc','squadSkills'].forEach(id=>document.getElementById(id).value='');
  closeModal('squadOverlay');
  await loadSquad();
  renderProfile();
  toast('Squad post published — requests will appear here 🛠','success');
});

/* ─── CHAT ────────────────────────────────────────────────────── */
async function createChatThread(squadId, ownerId, applicantId){
  const { error } = await sb.from('chat_threads').insert({
    squad_id: squadId, owner_id: ownerId, applicant_id: applicantId
  });
  // Unique constraint means "already exists" is expected/harmless on double-accept.
  if(error && !/duplicate/i.test(error.message)) console.error(error);
}

async function loadChatThreads(){
  if(!session){ chatThreads = []; renderChat(); return; }

  const { data: threadRows, error } = await sb
    .from('chat_threads').select('*').order('created_at',{ascending:false});
  if(error){ console.error(error); return; }

  const ids = (threadRows||[]).map(t=>t.id);
  let msgRows = [];
  if(ids.length){
    const { data, error: mErr } = await sb
      .from('messages').select('*').in('thread_id', ids).order('created_at',{ascending:true});
    if(mErr) console.error(mErr);
    msgRows = data || [];
  }

  await ensureProfilesCached([
    ...(threadRows||[]).map(t=>t.owner_id),
    ...(threadRows||[]).map(t=>t.applicant_id),
    ...msgRows.map(m=>m.sender_id)
  ]);

  const myId = profile.id;
  chatThreads = (threadRows||[]).map(t=>{
    const otherId = t.owner_id===myId ? t.applicant_id : t.owner_id;
    const msgs = msgRows.filter(m=>m.thread_id===t.id);
    const lastSeenKey = `devdome_lastseen_${t.id}`;
    const lastSeen = Number(localStorage.getItem(lastSeenKey)||0);
    const lastMsg = msgs[msgs.length-1];
    return {
      id: t.id,
      squadId: t.squad_id,
      squadRole: squadPosts.find(s=>s.id===t.squad_id)?.role || 'Squad Post',
      ownerId: t.owner_id,
      applicantId: t.applicant_id,
      otherId,
      otherName: usernameFor(otherId),
      messages: msgs.map(m=>({ sender: m.sender_id, senderName: usernameFor(m.sender_id), text: m.text, ts: new Date(m.created_at).getTime() })),
      unread: !!(lastMsg && lastMsg.sender_id!==myId && new Date(lastMsg.created_at).getTime() > lastSeen)
    };
  });
  updateChatTabDot();
  renderChat();
}

function hasUnread(){ return chatThreads.some(t=>t.unread); }

function updateChatTabDot(){
  const btn = document.getElementById('chatTabBtn');
  const existing = btn.querySelector('.notif-dot');
  if(hasUnread()){
    if(!existing){ const d=document.createElement('div'); d.className='notif-dot'; btn.appendChild(d); }
  } else {
    if(existing) existing.remove();
  }
}

function openChatForSquad(squadId){
  const thread = chatThreads.find(t=>t.squadId===squadId);
  if(!thread){ toast('Opening that chat — give it a second and try again.','info'); return; }
  activeChatId = thread.id;
  switchTab('chat');
  renderChat();
}

function renderChat(){
  document.getElementById('chatRequireAuth').hidden = !!session;
  document.getElementById('chatLayout').hidden = !session;
  if(!session) return;

  const threadList = document.getElementById('threadList');
  if(chatThreads.length === 0){
    threadList.innerHTML = `<div style="padding:20px;color:var(--text-faint);font-size:13px;text-align:center;line-height:1.6;">No chats yet.<br>Get accepted to a squad post to start chatting.</div>`;
  } else {
    threadList.innerHTML = chatThreads.map(t=>{
      const lastMsg = t.messages[t.messages.length-1];
      const preview = lastMsg ? lastMsg.text.slice(0,36)+(lastMsg.text.length>36?'…':'') : 'No messages yet';
      const idx = colorIdxFor(t.otherName);
      const initials = (t.otherName||'?').slice(0,2).toUpperCase();
      return `
        <div class="chat-thread-item ${activeChatId===t.id?'active':''}" data-tid="${t.id}">
          <div class="thread-avatar" style="background:${AVATAR_COLORS[idx]};">${esc(initials)}</div>
          <div class="thread-info">
            <div class="thread-name">@${esc(t.otherName)} ${t.unread?'<span style="color:var(--ember);font-size:10px;">●</span>':''}</div>
            <div class="thread-preview">${esc(t.squadRole)} · ${esc(preview)}</div>
          </div>
        </div>`;
    }).join('');
    threadList.querySelectorAll('.chat-thread-item').forEach(el=>{
      el.addEventListener('click',()=>{
        activeChatId = +el.dataset.tid;
        const t = chatThreads.find(x=>x.id===activeChatId);
        if(t){ t.unread=false; localStorage.setItem(`devdome_lastseen_${t.id}`, String(Date.now())); }
        updateChatTabDot();
        renderChat();
      });
    });
  }

  const chatMain = document.getElementById('chatMain');
  if(!activeChatId){
    chatMain.innerHTML = `<div class="no-chat-selected"><div class="emoji">💬</div><div style="font-family:'Chakra Petch',sans-serif;font-size:15px;color:var(--text-muted);margin-bottom:6px;">Pick a conversation</div><div style="font-size:13px;">Accepted squad requests unlock a private chat channel.</div></div>`;
    return;
  }

  const thread = chatThreads.find(t=>t.id===activeChatId);
  if(!thread){ chatMain.innerHTML=''; activeChatId=null; return; }

  const idx = colorIdxFor(thread.otherName);
  const myIdx = colorIdxFor(profile.username);

  chatMain.innerHTML = `
    <div class="chat-header">
      <div class="thread-avatar" style="background:${AVATAR_COLORS[idx]};width:36px;height:36px;">${esc((thread.otherName||'?').slice(0,2).toUpperCase())}</div>
      <div>
        <div class="chat-header-name">@${esc(thread.otherName)}</div>
        <div class="chat-header-context">${esc(thread.squadRole)}</div>
      </div>
    </div>
    <div class="chat-messages" id="chatMessages">
      ${thread.messages.length===0
        ? `<div class="chat-empty">Send a message to kick things off 👋</div>`
        : thread.messages.map(m=>{
            const mine = m.sender===profile.id;
            const senderIdx = mine ? myIdx : idx;
            const initials = (m.senderName||'?').slice(0,2).toUpperCase();
            const timeStr = new Date(m.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
            return `
              <div class="msg-row ${mine?'mine':''}">
                <div class="msg-avatar" style="background:${AVATAR_COLORS[senderIdx]};">${esc(initials)}</div>
                <div>
                  <div class="msg-bubble">${esc(m.text)}</div>
                  <div class="msg-meta">@${esc(m.senderName)} · ${timeStr}</div>
                </div>
              </div>`;
          }).join('')
      }
    </div>
    <div class="chat-input-bar">
      <textarea class="chat-input" id="chatInput" placeholder="Message @${esc(thread.otherName)}…" rows="1"></textarea>
      <button class="send-btn" id="sendBtn">Send</button>
    </div>`;

  document.getElementById('sendBtn').addEventListener('click', sendMessage);
  document.getElementById('chatInput').addEventListener('keydown', e=>{
    if(e.key==='Enter' && !e.shiftKey){ e.preventDefault(); sendMessage(); }
  });

  const msgs = document.getElementById('chatMessages');
  if(msgs) setTimeout(()=>msgs.scrollTop=msgs.scrollHeight, 50);
}

async function sendMessage(){
  const input = document.getElementById('chatInput');
  if(!input||!activeChatId) return;
  const text = input.value.trim();
  if(!text) return;
  input.value='';

  const { error } = await sb.from('messages').insert({ thread_id: activeChatId, sender_id: profile.id, text });
  if(error){ toast(error.message,'warn'); return; }
  localStorage.setItem(`devdome_lastseen_${activeChatId}`, String(Date.now()));
  await loadChatThreads();
  renderChat();
}

/* ─── PROFILE ─────────────────────────────────────────────────── */
function renderProfile(){
  if(!session || !profile){
    renderProfileNameArea();
    document.getElementById('profileHandle').textContent = 'Not signed in';
    document.getElementById('statRow').innerHTML = '';
    document.getElementById('skillStack').innerHTML = '';
    document.getElementById('badgeRow').innerHTML = '';
    document.getElementById('myPitches').innerHTML = `<div class="empty-state" style="padding:20px;"><p>Sign in to see your pitches.</p></div>`;
    document.getElementById('mySquadPosts').innerHTML = `<div style="color:var(--text-faint);font-size:13px;padding:10px 0;">Sign in to see your squad posts.</div>`;
    return;
  }

  const myPitches = pitches.filter(p=>p.mine);
  const mySquad = squadPosts.filter(s=>s.mine);
  const totalVotes = myPitches.reduce((a,p)=>a+p.votesPlay+p.votesHelp,0);

  renderProfileNameArea();
  document.getElementById('profileHandle').textContent = '@' + profile.username;
  const initials = profile.username.slice(0,2).toUpperCase();
  const av = document.getElementById('profileAvatar');
  av.textContent = initials;
  av.style.background = AVATAR_COLORS[colorIdxFor(profile.username)];

  document.getElementById('statRow').innerHTML = `
    <div class="stat"><b>${myPitches.length}</b><span>Pitches</span></div>
    <div class="stat"><b>${totalVotes}</b><span>Votes</span></div>
    <div class="stat"><b>${mySquad.length}</b><span>Squad Posts</span></div>
    <div class="stat"><b>${chatThreads.length}</b><span>Active Chats</span></div>
  `;

  const stack = document.getElementById('skillStack');
  stack.innerHTML = (profile.skills||[]).map(s=>`<span class="skill-pill">${esc(s)}</span>`).join('')
    + `<span class="skill-pill add-skill" id="addSkillBtn">+ Add skill</span>`;
  document.getElementById('addSkillBtn').addEventListener('click', promptAddSkill);

  const badges=[];
  if(totalVotes>=50) badges.push({icon:'🔥',name:'Trending Pitcher',desc:'50+ total votes',bg:'var(--ember-dim)'});
  else if(totalVotes>=20) badges.push({icon:'🔥',name:'Hot Pitcher',desc:'20+ total votes',bg:'var(--ember-dim)'});
  if(myPitches.length>=1) badges.push({icon:'⛏',name:'Forge Starter',desc:'First pitch posted',bg:'rgba(100,100,100,.15)'});
  if(myPitches.length>=5) badges.push({icon:'⛏⛏',name:'Idea Machine',desc:'5+ pitches posted',bg:'rgba(100,100,100,.15)'});
  if(mySquad.length>=1) badges.push({icon:'🤝',name:'Squad Leader',desc:'Recruiting a team',bg:'var(--cyan-dim)'});
  if(chatThreads.length>=1) badges.push({icon:'💬',name:'Connected',desc:'Active chat with a teammate',bg:'var(--green-dim)'});
  if(badges.length===0) badges.push({icon:'🌱',name:'New Builder',desc:'Post a pitch to earn your first badge',bg:'var(--green-dim)'});

  document.getElementById('badgeRow').innerHTML = badges.map(b=>`
    <div class="badge">
      <div class="badge-icon" style="background:${b.bg}">${b.icon}</div>
      <div><div class="badge-name">${esc(b.name)}</div><div class="badge-desc">${esc(b.desc)}</div></div>
    </div>
  `).join('');

  document.getElementById('myPitches').innerHTML = myPitches.length ? myPitches.map(p=>`
    <div class="mini-item">
      <span>${esc(p.title)}</span>
      <span class="meta">🔥${p.votesPlay} · 🛠${p.votesHelp}</span>
    </div>
  `).join('') : `<div class="empty-state" style="padding:20px;"><p>No pitches yet. Post your first idea!</p></div>`;

  document.getElementById('mySquadPosts').innerHTML = mySquad.length ? mySquad.map(s=>{
    const pending = s.joinRequests.filter(r=>r.status==='pending').length;
    const accepted = s.joinRequests.filter(r=>r.status==='accepted').length;
    return `
    <div class="mini-item">
      <span>${esc(s.role)} — ${esc(s.gameType)}</span>
      <span class="meta">${pending>0?`${pending} pending · `:''} ${accepted} accepted</span>
    </div>`;
  }).join('') : `<div style="color:var(--text-faint);font-size:13px;padding:10px 0;">No squad posts yet.</div>`;
}

/* ─── SETTINGS ────────────────────────────────────────────────── */
document.getElementById('settingsBtn').addEventListener('click',()=>requireAuth(()=>openModal('settingsOverlay')));

/* ─── SKILLS ──────────────────────────────────────────────────── */
async function promptAddSkill(){
  const skill = prompt('Add a skill (letters, numbers, spaces only):');
  if(!skill||!skill.trim()) return;
  const clean = skill.trim().slice(0,30);
  const next = [...(profile.skills||[]), clean];
  const { error } = await sb.from('profiles').update({ skills: next }).eq('id', profile.id);
  if(error){ toast(error.message,'warn'); return; }
  profile.skills = next;
  renderProfile();
  toast('Skill added.','info');
}

/* ─── REALTIME SUBSCRIPTIONS ─────────────────────────────────────
   These push live updates to every open tab/device the instant
   something changes in the database — no manual refresh needed. */
let realtimeChannel = null;
function setupRealtime(){
  if(realtimeChannel) sb.removeChannel(realtimeChannel);
  realtimeChannel = sb.channel('devdome-live')
    .on('postgres_changes', { event:'*', schema:'public', table:'pitches' }, ()=>loadPitches())
    .on('postgres_changes', { event:'*', schema:'public', table:'votes' }, ()=>loadPitches())
    .on('postgres_changes', { event:'*', schema:'public', table:'squad_posts' }, ()=>loadSquad())
    .on('postgres_changes', { event:'*', schema:'public', table:'join_requests' }, ()=>loadSquad())
    .on('postgres_changes', { event:'*', schema:'public', table:'chat_threads' }, ()=>loadChatThreads())
    .on('postgres_changes', { event:'*', schema:'public', table:'messages' }, ()=>{ loadChatThreads().then(()=>{ if(document.getElementById('page-chat') && !document.getElementById('page-chat').hidden) renderChat(); }); })
    .subscribe();
}

/* ─── AUTH STATE / BOOTSTRAP ─────────────────────────────────────
   This is the single source of truth: whenever Supabase tells us
/* ─── AUTH STATE / BOOTSTRAP ─────────────────────────────────────
   This is the single source of truth: whenever Supabase tells us
   the session changed (sign in, sign out, token refresh, OAuth
   redirect return), we reload the current user's profile and
   every list, so the UI always matches what's really in the DB. */
async function loadOwnProfile(){
  if(!session){ profile = null; return; }
  const { data, error } = await sb.from('profiles').select('*').eq('id', session.user.id).single();
  if(error){ console.error(error); profile = null; return; }
  profile = data;
}

async function refreshEverything(){
  await loadOwnProfile();
  applyAuthUI();
  await loadPitches();
  await loadSquad();
  await loadChatThreads();
  renderProfile();
}

let booted = false;
let refreshing = Promise.resolve();

// onAuthStateChange fires once immediately with the current session
// (even before boot() runs) AND again on every later sign-in/out/token
// refresh/OAuth redirect. We let it drive every refresh, and re-subscribe
// realtime each time too, since RLS means the rows we're allowed to see
// change with who's signed in.
sb.auth.onAuthStateChange((event, newSession)=>{
  session = newSession;
  refreshing = refreshing.then(refreshEverything).then(setupRealtime).catch(console.error);
});

async function boot(){
  await refreshing; // wait for the first onAuthStateChange-triggered load + subscribe
  booted = true;
  document.getElementById('appLoading').hidden = true;
  document.getElementById('appRoot').hidden = false;
}

boot();