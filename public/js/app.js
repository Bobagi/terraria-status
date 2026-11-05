(function(){
  var HEARTS_SVG = '<svg viewBox="0 0 32 30"><path d="M16 29C6 22 2 16 2 10a7 7 0 0 1 14-2 7 7 0 0 1 14 2c0 6-4 12-14 19Z"/></svg>';

  function $(id){return document.getElementById(id);}
  function fmtBytes(n){
    if(n==null||isNaN(n))return '-';
    if(n<1024)return n+' B';
    var u=['KB','MB','GB','TB'],i=-1;do{n/=1024;i++;}while(n>=1024&&i<u.length-1);
    return (n>=100?Math.round(n):n.toFixed(1))+' '+u[i];
  }
  function fmtUptime(s){
    if(s==null)return '-';
    var d=Math.floor(s/86400);s%=86400;var h=Math.floor(s/3600);s%=3600;var m=Math.floor(s/60);
    var p=[];if(d)p.push(d+'d');if(h)p.push(h+'h');p.push(m+'m');return p.join(' ');
  }
  function fmtAgo(iso){
    if(!iso)return 'agora';
    var s=Math.max(0,Math.round((Date.now()-new Date(iso).getTime())/1000));
    if(s<5)return 'agora';if(s<60)return 'há '+s+'s';var m=Math.floor(s/60);return 'há '+m+'min';
  }

  function renderHearts(count,max){
    var box=$('hearts');if(box.childElementCount!==max){box.innerHTML='';for(var i=0;i<max;i++){var d=document.createElement('div');d.className='heart off';d.innerHTML=HEARTS_SVG;box.appendChild(d);}}
    for(var j=0;j<box.childElementCount;j++){box.children[j].className='heart '+(j<count?'on':'off');}
  }

  var lastUpdated=null, currentPlayers=[], openPlayerName=null, lastFocus=null;

  function fmtDur(s){
    if(s==null)return '';
    if(s<60)return '~'+s+'s';var m=Math.floor(s/60);
    if(m<60)return '~'+m+'min';var h=Math.floor(m/60);m=m%60;
    return '~'+h+'h'+(m?(' '+m+'min'):'');
  }

  // ---- player modal (all text via textContent, names are user-controlled) ----
  function el(tag,cls,txt){var e=document.createElement(tag);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;return e;}
  // Lucide icon from the sprite built by tools/build-icons.mjs (decorative: hidden from screen readers)
  var SVGNS='http://www.w3.org/2000/svg';
  function icon(name){
    var svg=document.createElementNS(SVGNS,'svg'),use=document.createElementNS(SVGNS,'use');
    svg.setAttribute('class','ic');svg.setAttribute('aria-hidden','true');
    use.setAttribute('href','/icons/icons.svg#'+name);svg.appendChild(use);return svg;
  }
  function barEl(label,cls,cur,max){
    var w=el('div','m-vital'),top=el('div','top');
    top.appendChild(el('span',null,label));
    top.appendChild(el('b',null,(cur!=null?cur:'?')+' / '+max));
    var bar=el('div','bar'),fill=el('div','fill '+cls);
    fill.style.width=Math.max(0,Math.min(100,(cur/max)*100))+'%';
    bar.appendChild(fill);w.appendChild(top);w.appendChild(bar);return w;
  }
  // ---- deterministic per-name portrait (pure vector, no user text embedded) ----
  function hashCode(s){var h=2166136261>>>0;s=(s||'?')+'';for(var i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619);}return h>>>0;}
  function portraitSVG(name){
    var h=hashCode(name);
    var skins=['#f2c9a0','#e8b48a','#c98a5e','#a86c46','#7a4a2b','#f6d5b8'];
    var hairs=['#3a2a1a','#6b3d1f','#141414','#c9962e','#8a1f1f','#5a5a6a','#d9d2c0','#2a5a8a'];
    var shirts=['#c0392b','#2980b9','#27ae60','#8e44ad','#d68910','#16a085','#c0447a','#455a94'];
    var bgs=['#1b2a4a','#2a1b4a','#123a2a','#3a2a12','#0f2f3a','#3a1230'];
    var skin=skins[h%skins.length],hair=hairs[(h>>3)%hairs.length],shirt=shirts[(h>>7)%shirts.length],bg=bgs[(h>>11)%bgs.length];
    var st=(h>>13)%3;
    var hairTop = st===0
      ? '<rect x="9" y="4" width="14" height="6" fill="'+hair+'"/><rect x="8" y="6" width="2" height="6" fill="'+hair+'"/><rect x="22" y="6" width="2" height="6" fill="'+hair+'"/>'
      : st===1
      ? '<rect x="9" y="3" width="14" height="6" fill="'+hair+'"/><rect x="13" y="1" width="6" height="3" fill="'+hair+'"/><rect x="21" y="6" width="3" height="5" fill="'+hair+'"/>'
      : '<rect x="8" y="4" width="16" height="6" fill="'+hair+'"/><rect x="7" y="8" width="3" height="13" fill="'+hair+'"/><rect x="22" y="8" width="3" height="13" fill="'+hair+'"/>';
    return '<svg viewBox="0 0 32 32" shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">'
      +'<rect width="32" height="32" fill="'+bg+'"/>'
      +'<rect x="9" y="22" width="14" height="10" fill="'+shirt+'"/>'
      +'<rect x="13" y="20" width="6" height="3" fill="'+skin+'"/>'
      +'<rect x="10" y="8" width="12" height="12" rx="1" fill="'+skin+'"/>'
      +hairTop
      +'<rect x="12" y="12" width="2" height="3" fill="#20304a"/><rect x="18" y="12" width="2" height="3" fill="#20304a"/>'
      +'</svg>';
  }
  // Per-player emblem avatar, deterministic by name. Preference order:
  //  1) a Terraria town-NPC/critter map-head (a real face, best),
  //  2) a curated colorful item sprite,
  //  3) the drawn portrait (if no sprite set is installed).
  // Curated town-NPC head ids that read well as faces (skip the "?" default,
  // hard-to-read grey critters and the item-like tail end).
  var NPC_AVATARS=[1,2,3,4,5,7,8,10,11,12,13,14,15,17,19,20,22,23,24,25,45,48,51,52,53,57,58,59,60,62,63,69,71,72,77];
  var AVATARS=[65,757,674,46,3065,494,112,1928,1244,180,181,182,184,999,1309,3018,2880,1256,1326,950,4952,267,3541,1178];
  function avatarEl(name){
    var h=hashCode(name),src=null;
    if(spritesOn.npc)      src='/sprites/npc/'+NPC_AVATARS[h%NPC_AVATARS.length]+'.png';
    else if(spritesOn.item)src='/sprites/item/'+AVATARS[h%AVATARS.length]+'.png';
    if(src){
      var img=document.createElement('img');img.className='av-img';img.alt='';img.loading='lazy';img.src=src;
      img.onerror=function(){var s=document.createElement('span');s.innerHTML=portraitSVG(name);
        if(img.parentNode)img.parentNode.replaceChild(s.firstChild,img);};
      return img;
    }
    var sp=document.createElement('span');sp.style.cssText='display:block;width:100%;height:100%';
    sp.innerHTML=portraitSVG(name);return sp;
  }

  // ---- item rarity + category glyphs ----
  function rarityColor(r){
    var m={'-1':'#8a8a8a','0':'#e9e6ff','1':'#8aa9ff','2':'#96ff96','3':'#ffb46a','4':'#ff8a8a',
      '5':'#ff8ad6','6':'#d2a0ff','7':'#b6e84a','8':'#ffd23f','9':'#4fd6ff','10':'#ff3b57','11':'#c58bff'};
    if(r==null)return '#6b64b8';
    if(m[r])return m[r];
    return r>11?'#ff9e42':'#8a8a8a';
  }
  // Item category → Lucide icon (public/icons/icons.svg), shown when there is no pixel sprite.
  var GLYPHS={melee:'sword',ranged:'bow-arrow',magic:'wand-sparkles',summon:'paw-print',weapon:'sword',
    tool:'pickaxe',armor:'shield',accessory:'circle-dot',ammo:'move-up-right',potion:'flask-round',
    block:'box',coin:'coins',material:'gem'};
  function glyphEl(kind){var s=el('span','glyph');s.appendChild(icon(GLYPHS[kind]||GLYPHS.material));return s;}
  var KIND_LABEL={melee:'Arma corpo-a-corpo',ranged:'Arma à distância',magic:'Arma mágica',summon:'Invocação',weapon:'Arma',tool:'Ferramenta',armor:'Armadura',accessory:'Acessório',ammo:'Munição',potion:'Poção',block:'Bloco',coin:'Moeda',material:'Material'};
  var spritesOn={item:false,buff:false,npc:false};

  function itemTile(it){
    var w=el('span','itile');
    w.style.setProperty('--rc',rarityColor(it.rarity));
    var full=(it.prefix?it.prefix+' ':'')+(it.name||'?');
    w.title=full;w.setAttribute('aria-label',full); // .title/.aria-label are attributes → name stays inert
    if(spritesOn.item&&it.id!=null&&it.id>=0){
      var img=document.createElement('img');img.alt='';img.loading='lazy';var t=0;
      var srcs=['/sprites/item/'+it.id+'.png','/sprites/item/Item_'+it.id+'.png']; // accept both naming schemes
      img.src=srcs[0];
      img.onerror=function(){t++;if(t<srcs.length){img.src=srcs[t];}else if(img.parentNode){img.parentNode.replaceChild(glyphEl(it.kind),img);}};
      w.appendChild(img);
    }else{w.appendChild(glyphEl(it.kind));}
    if(it.stack>1)w.appendChild(el('span','stk','×'+it.stack));
    return w;
  }
  function tileGrid(items){var g=el('div','itile-grid');items.forEach(function(it){g.appendChild(itemTile(it));});return g;}
  function buffChip(b){
    var c=el('span','buff'),bi=el('span','bi');
    if(spritesOn.buff&&b.id!=null&&b.id>=0){
      var img=document.createElement('img');img.alt='';img.loading='lazy';var t=0;
      var srcs=['/sprites/buff/'+b.id+'.png','/sprites/buff/Buff_'+b.id+'.png'];
      img.src=srcs[0];
      img.onerror=function(){t++;if(t<srcs.length){img.src=srcs[t];}else{bi.replaceChildren(icon('sparkle'));}};
      bi.appendChild(img);
    }else{bi.appendChild(icon('sparkle'));}
    c.appendChild(bi);c.appendChild(document.createTextNode(b.name||''));
    return c;
  }
  function coinsEl(w){
    var box=el('span','coins');
    if(!w||(!w.plat&&!w.gold&&!w.silver&&!w.copper)){box.appendChild(el('span','zero','sem moedas'));return box;}
    [['p',w.plat],['g',w.gold],['s',w.silver],['c',w.copper]].forEach(function(c){
      if(!c[1])return;var e=el('span','coin '+c[0]);e.appendChild(el('i'));e.appendChild(document.createTextNode(c[1]));box.appendChild(e);
    });
    return box;
  }
  function pill(cls,txt,ic){var p=el('span','m-pill '+cls);if(ic)p.appendChild(icon(ic));p.appendChild(document.createTextNode(txt));return p;}
  function wpill(cls,txt,ic){var s=el('span','wp'+(cls?' '+cls:''));if(ic)s.appendChild(icon(ic));s.appendChild(document.createTextNode(txt));return s;}

  function renderStats(st){
    var f=document.createDocumentFragment();
    if(st.lifeMax)f.appendChild(barEl('Vida','life',st.dead?0:st.life,st.lifeMax));
    if(st.manaMax)f.appendChild(barEl('Mana','mana',st.mana,st.manaMax));
    var grid=el('div','m-grid');
    function stat(k,v){if(v==null||v===''||typeof v==='object')return;var c=el('div','m-stat');c.appendChild(el('div','k',k));c.appendChild(el('div','v',v));grid.appendChild(c);}
    stat('Defesa',st.defense);stat('Modo',st.difficulty);
    if(st.deaths!=null)stat('Mortes',st.deaths);
    stat('Itens no inventário',st.inventoryCount);
    if(grid.childElementCount)f.appendChild(grid);
    if(st.wealth){f.appendChild(el('div','m-sec-title','Riqueza'));var wb=el('div');wb.appendChild(coinsEl(st.wealth));f.appendChild(wb);}
    if(st.held){
      f.appendChild(el('div','m-sec-title','Na mão'));
      var h=el('div','m-held');h.appendChild(itemTile(st.held));
      var hn=el('div','hn');hn.appendChild(el('b',null,(st.held.prefix?st.held.prefix+' ':'')+st.held.name));
      hn.appendChild(el('small',null,KIND_LABEL[st.held.kind]||'Item'));h.appendChild(hn);f.appendChild(h);
    }
    function section(title,arr){if(arr&&arr.length){f.appendChild(el('div','m-sec-title',title));f.appendChild(tileGrid(arr));}}
    section('Equipado',st.equips);section('Vaidade',st.vanity);section('Utilitários',st.misc);
    section('Munição',st.ammo);section('Inventário',st.inventory);
    if(st.buffs&&st.buffs.length){
      f.appendChild(el('div','m-sec-title','Buffs ativos'));var bl=el('div','m-list');
      st.buffs.forEach(function(b){bl.appendChild(buffChip(typeof b==='string'?{name:b,id:-1}:b));});f.appendChild(bl);
    }
    return f;
  }
  function fillModal(p){
    var mav=$('mAv');mav.textContent='';mav.appendChild(avatarEl(p.name));
    $('mTitle').textContent=p.name;
    var sess=$('mSession');sess.textContent='';
    sess.appendChild(el('span','dotg'));
    sess.appendChild(document.createTextNode('online '+(p.onlineForSec!=null?('há '+fmtDur(p.onlineForSec)):'agora')
      +(p.stats&&typeof p.stats.pingMs==='number'?(' · ping '+p.stats.pingMs+' ms'):'')));
    var body=$('mBody');body.textContent='';
    var st=p.stats;
    if(st){
      var badges=el('div','m-badges');
      if(st.dead)badges.appendChild(pill('dead','Morto'+(st.respawnSec?(' · volta em '+st.respawnSec+'s'):''),'skull'));
      else badges.appendChild(pill('alive','Vivo','heart-pulse'));
      if(st.biome)badges.appendChild(pill('biome',st.biome,'map-pin'));
      body.appendChild(badges);
      body.appendChild(renderStats(st));
    }else{
      var note=el('div','m-note');
      note.innerHTML='<b>Vida, mana, defesa, equipamentos e inventário</b> aparecem aqui quando o '+
        'mod de stats está ativo no servidor. Ele é <b>server-side</b>, você <b>não</b> precisa dele pra entrar. '+
        'Sem ele, o servidor só informa <b>quem</b> está online e há quanto tempo. Detalhes no '+
        '<a href="https://github.com/Bobagi/terraria-status#character-stats-optional" target="_blank" rel="noopener">repositório</a>.';
      body.appendChild(note);
    }
  }
  function openModal(name){
    var p=currentPlayers.filter(function(x){return x.name===name;})[0];
    if(!p)return;
    openPlayerName=name;lastFocus=document.activeElement;fillModal(p);
    var m=$('modal');m.hidden=false;requestAnimationFrame(function(){m.classList.add('show');});
    $('modalX').focus();document.body.style.overflow='hidden';
  }
  function closeModal(){
    openPlayerName=null;var m=$('modal');m.classList.remove('show');document.body.style.overflow='';
    setTimeout(function(){m.hidden=true;},180);
    if(lastFocus&&lastFocus.focus)lastFocus.focus();
  }
  $('modalX').addEventListener('click',closeModal);
  $('modal').addEventListener('click',function(e){if(e.target===$('modal'))closeModal();});
  document.addEventListener('keydown',function(e){if(e.key==='Escape'&&openPlayerName)closeModal();});
  $('modal').addEventListener('keydown',function(e){
    if(e.key!=='Tab')return;
    var foc=$('modal').querySelectorAll('button,a[href]');if(!foc.length)return;
    var first=foc[0],last=foc[foc.length-1];
    if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}
    else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}
  });

  // ---- day/night sky driven by the in-game clock (from the optional mod) ----
  var reducedMotion=window.matchMedia&&window.matchMedia('(prefers-reduced-motion:reduce)').matches;
  // [hour, topRGB, midRGB, lowRGB] keyframes across a Terraria day; JS lerps between them.
  var SKY_ANCHORS=[
    [0,   [6,7,26],   [12,12,36],  [30,22,64]],
    [4.5, [16,16,44], [40,30,66],  [95,60,86]],
    [6.3, [70,66,120],[210,120,92],[250,182,120]],
    [8.5, [42,92,168],[96,150,206],[158,196,228]],
    [13,  [46,110,190],[100,162,214],[176,208,234]],
    [17,  [52,96,164],[128,146,198],[212,192,192]],
    [18.6,[42,44,104],[220,112,90],[250,158,110]],
    [20,  [12,14,42],  [24,20,60],  [58,40,90]],
    [24,  [6,7,26],   [12,12,36],  [30,22,64]]
  ];
  function lerp(a,b,t){return Math.round(a+(b-a)*t);}
  function rgb(c){return 'rgb('+c[0]+','+c[1]+','+c[2]+')';}
  function skyColors(h){
    for(var i=0;i<SKY_ANCHORS.length-1;i++){
      var a=SKY_ANCHORS[i],b=SKY_ANCHORS[i+1];
      if(h>=a[0]&&h<=b[0]){var t=(h-a[0])/(b[0]-a[0]);
        return [[lerp(a[1][0],b[1][0],t),lerp(a[1][1],b[1][1],t),lerp(a[1][2],b[1][2],t)],
                [lerp(a[2][0],b[2][0],t),lerp(a[2][1],b[2][1],t),lerp(a[2][2],b[2][2],t)],
                [lerp(a[3][0],b[3][0],t),lerp(a[3][1],b[3][1],t),lerp(a[3][2],b[3][2],t)]];}
    }
    return [SKY_ANCHORS[0][1],SKY_ANCHORS[0][2],SKY_ANCHORS[0][3]];
  }
  var sky={hour:null,phase:0,last:0};
  var skySeeded=false; // seed the day/night clock ONCE from the server, then run purely client-side
  // Current time from the client-side sky clock (so the world-panel pill stays in
  // sync with the moving sun/moon instead of re-reading the server each poll).
  function skyClock(){
    if(sky.hour==null)return null;
    var h=(sky.hour+24)%24,hh=Math.floor(h),mm=Math.floor((h-hh)*60);
    return {day:h>=4.5&&h<19.5,text:(hh<10?'0':'')+hh+':'+(mm<10?'0':'')+mm};
  }
  function renderSky(){
    var h=sky.hour;if(h==null)return;h=(h+24)%24;
    var isDay=h>=4.5&&h<19.5;
    var frac=isDay?(h-4.5)/15:(((h<4.5?h+24:h)-19.5)/9);
    frac=Math.max(0,Math.min(1,frac));
    var x=5+frac*90, y=78-Math.sin(frac*Math.PI)*64;   // arc across the top of the viewport
    var sun=$('sun'),moon=$('moon');
    var body=isDay?sun:moon, other=isDay?moon:sun;
    body.style.left=x+'vw';body.style.top=y+'vh';body.style.right='auto';body.style.opacity='1';
    other.style.opacity='0';
    var ph=$('moonPh'),p=(((sky.phase||0)%8)+8)%8;     // 0 = full, 4 = new
    if(p===0){ph.style.opacity='0';}
    else{var illum=(p<4)?(4-p)/4:(p-4)/4,side=(p<4)?1:-1;
      ph.style.opacity='1';ph.style.transform='translateX('+(illum*110*side)+'%)';}
    var g=skyColors(h);
    ph.style.background=rgb(g[0]);
    $('skyEl').style.background='linear-gradient(180deg,'+rgb(g[0])+' 0%,'+rgb(g[1])+' 45%,'+rgb(g[2])+' 100%)';
    $('starsEl').style.opacity=isDay?'0':(h<5.2||h>19.8?'0.85':'0.5');
    // the ground silhouette greens up in daylight, back to dark purple at night
    var dl=isDay?(0.28+0.72*Math.sin(frac*Math.PI)):0;
    $('hillFar').setAttribute('fill',rgb([lerp(21,55,dl),lerp(15,112,dl),lerp(44,62,dl)]));
    $('hillNear').setAttribute('fill',rgb([lerp(12,30,dl),lerp(8,80,dl),lerp(32,44,dl)]));
  }
  function setSkyFromLive(live){
    if(!live||live.timeText==null){   // no live clock (server empty/frozen) → default dusk art
      if(sky.hour===null)return;
      sky.hour=null;
      $('skyEl').style.background='';$('starsEl').style.opacity='';
      var mn=$('moon');mn.style.left='';mn.style.top='';mn.style.right='';mn.style.opacity='';
      $('sun').style.opacity='0';$('moonPh').style.opacity='0';
      return;
    }
    var m=/^(\d{1,2}):(\d{2})$/.exec(live.timeText);
    sky.hour=m?(parseInt(m[1],10)+parseInt(m[2],10)/60):(live.dayTime?12:0);
    sky.phase=live.moonPhase||0;sky.last=performance.now();
    renderSky();
  }
  // Advance the clock locally so the sun/moon glide (seeded once, not re-synced).
  // Terraria's day is LONGER than its night: 15 in-game hours in 900 s real (15 min,
  // dayLength 54000 ticks) vs 9 hours in 540 s real (9 min, nightLength 32400), so the
  // per-second rate switches at dawn/dusk (4:30) and dusk (19:30).
  function skyTick(ts){
    if(sky.hour!=null&&!reducedMotion){
      var dt=(ts-sky.last)/1000;sky.last=ts;
      var rate=(sky.hour>=4.5&&sky.hour<19.5)?(15/900):(9/540);
      sky.hour=(sky.hour+rate*dt)%24;renderSky();
    }else{sky.last=ts;}
    requestAnimationFrame(skyTick);
  }
  requestAnimationFrame(skyTick);

  function apply(d){
    lastUpdated=d.updatedAt;
    // Detect the sprite set BEFORE rendering avatars/tiles (else the first paint
    // falls back to glyphs/portraits for a frame).
    if(d.server&&d.server.sprites){spritesOn.item=!!d.server.sprites.item;spritesOn.buff=!!d.server.sprites.buff;spritesOn.npc=!!d.server.sprites.npc;}
    // Seed the sky clock only on the FIRST poll that carries a live in-game time,
    // then let the client-side rAF tween run standalone. We deliberately do NOT
    // re-sync every 5 s, the server's minute-resolution time would snap the sun/
    // moon and cause the stutter. (One request feeds everything; nothing extra is
    // polled for day/night.)
    if(!skySeeded&&d.world&&d.world.live&&d.world.live.timeText){setSkyFromLive(d.world.live);skySeeded=true;}
    // status gem
    var gem=$('gem'),gt=$('gemText');
    if(d.online){gem.className='status-gem is-online';gt.textContent='ONLINE';}
    else{gem.className='status-gem is-offline';gt.textContent='OFFLINE';}

    // players
    var pc=d.players.count||0,pm=d.players.max||8;
    $('pCount').textContent=pc;$('pMax').textContent=pm;$('pillSlots').textContent=pm;
    renderHearts(pc,pm);
    var list=(d.players&&d.players.list)||[];
    currentPlayers=list;
    var roster=$('roster'),empty=$('rosterEmpty'),hint=$('rosterHint');
    roster.innerHTML='';
    if(list.length){
      empty.hidden=true;hint.hidden=false;
      list.forEach(function(p){
        var li=document.createElement('li');
        var dead=p.stats&&p.stats.dead;
        var btn=el('button','ritem'+(dead?' is-dead':''));btn.type='button';
        var av=el('span','av');av.appendChild(avatarEl(p.name));btn.appendChild(av);
        var rn=el('span','rn');rn.appendChild(document.createTextNode(p.name));
        if(dead){var sk=icon('skull');sk.setAttribute('class','ic rdead');rn.appendChild(sk);}
        btn.appendChild(rn);
        var ping=p.stats&&p.stats.pingMs;
        if(typeof ping==='number'){
          var rp=el('span','rping'+(ping>=150?' bad':ping>=80?' mid':''),ping+' ms');
          rp.title='ping até o servidor';btn.appendChild(rp);
        }
        {var ch=icon('chevron-right');ch.setAttribute('class','ic chev');btn.appendChild(ch);}
        btn.addEventListener('click',function(){openModal(p.name);});
        li.appendChild(btn);roster.appendChild(li);
      });
    }else{empty.hidden=false;hint.hidden=true;}
    // keep an open modal in sync with fresh data (or close it if the player left)
    if(openPlayerName){
      var still=list.filter(function(p){return p.name===openPlayerName;})[0];
      if(still)fillModal(still);else closeModal();
    }

    // vitals
    var cpu=d.resources.cpuPerc,ram=d.resources.memPerc;
    if(cpu!=null){$('cpuVal').textContent=cpu.toFixed(1)+'%';
      var f=$('cpuFill');f.style.width=Math.min(100,cpu)+'%';
      f.className='fill cpu'+(cpu>=80?' hot':cpu>=45?' warn':'');}
    if(ram!=null){
      var used=fmtBytes(d.resources.memUsedBytes),lim=fmtBytes(d.resources.memLimitBytes);
      $('ramVal').textContent=used+' / '+lim+'  ('+ram.toFixed(0)+'%)';
      $('ramFill').style.width=Math.min(100,ram)+'%';
    }
    $('uptime').textContent=fmtUptime(d.container.uptimeSec);
    $('restarts').textContent=(d.container.restarts==null?'-':d.container.restarts);
    var net='-';
    if(d.resources.netRxText)net=d.resources.netRxText+' / '+d.resources.netTxText;
    $('net').textContent=net;
    $('disk').textContent=fmtBytes(d.resources.diskWorldBytes);
    // world simulation speed, only measured while someone is playing
    var tps=d.world&&d.world.live&&d.world.live.tps,te=$('tps');
    var tf=$('tpsFill');
    if(typeof tps==='number'){te.textContent=Math.round(tps)+' / 60 por s';
      tf.style.width=Math.min(100,tps/60*100)+'%';tf.className='fill tps'+(tps<50?' hot':tps<58?' warn':'');}
    else{te.textContent=d.players&&d.players.count?'medindo…':'parado';te.title=d.players&&d.players.count?'':'o servidor só simula o mundo com alguém jogando';tf.style.width='0';tf.className='fill tps';}
    var tiles=d.world&&d.world.tiles;
    if(tiles){$('worldSize').textContent=tiles.width+' x '+tiles.height+sizeName(tiles);
      $('pillSize').textContent='Mundo '+tiles.width+' x '+tiles.height;}

    // world + version freshness
    if(d.world&&d.world.name)$('worldName').textContent=d.world.name;
    $('lastSave').textContent=d.world.lastSaveAt?fmtAgo(d.world.lastSaveAt):'-';
    var s=d.server||{};
    $('ver').textContent=s.tmodloaderVersion?('v'+s.tmodloaderVersion):'-';
    var badge=$('verBadge'),warn=$('staleWarn');
    if(s.upToDate===true){badge.hidden=false;badge.className='vbadge ok';badge.replaceChildren(icon('check'),'atualizado');warn.hidden=true;}
    else if(s.upToDate===false){badge.hidden=false;badge.className='vbadge stale';badge.replaceChildren(icon('triangle-alert'),'desatualizada');
      warn.hidden=false;$('latestVer').textContent='v'+(s.latestVersion||'?');}
    else{badge.hidden=true;warn.hidden=true;}

    // live world extras (day/night, progression, events) from the optional mod
    var wl=$('wlive');wl.textContent='';
    var lw=d.world&&d.world.live;
    if(lw){
      wl.hidden=false;
      wl.appendChild(wpill('prog',lw.progression||'-','swords'));
      // day/night pill uses the seeded client clock (falls back to live only pre-seed)
      var sc=skyClock(),dn=sc||{day:lw.dayTime,text:lw.timeText};
      wl.appendChild(wpill('',(dn.day?'Dia':'Noite')+(dn.text?(' · '+dn.text):''),dn.day?'sun':'moon'));
      if(lw.bloodMoon)wl.appendChild(wpill('warn','Lua de Sangue','droplet'));
      if(lw.eclipse)wl.appendChild(wpill('warn','Eclipse Solar','eclipse'));
      if(lw.pumpkinMoon)wl.appendChild(wpill('warn','Lua Abóbora','ghost'));
      if(lw.snowMoon)wl.appendChild(wpill('warn','Lua Gelada','snowflake'));
    }else{wl.hidden=true;}
    renderBosses(d.world&&d.world.progress);

    // mods (once)
    var mbox=$('mods');
    if(!mbox.childElementCount&&d.mods){
      d.mods.forEach(function(m){
        var a=document.createElement('a');
        a.className='mod';a.href='https://steamcommunity.com/sharedfiles/filedetails/?id='+m.id;
        a.target='_blank';a.rel='noopener';a.style.setProperty('--mc','var(--'+m.rarity+')');
        a.innerHTML='<div class="mn"><span></span><span class="ext">Workshop <svg class="ic" aria-hidden="true"><use href="/icons/icons.svg#external-link"/></svg></span></div>'+
          '<div class="md"></div><div class="mid">ID '+m.id+'</div>';
        a.querySelector('.mn span').textContent=m.name;
        a.querySelector('.md').textContent=m.desc;
        mbox.appendChild(a);
      });
    }
    // address + steam launch
    if(s.ip){
      // Join via IP: the domain sits behind Cloudflare (HTTP only), so players need the raw IP
      if($('addr').textContent!==s.ip){$('addr').textContent=s.ip;fitAddr();}
      $('stepAddr').textContent=s.ip;
      if(s.port)$('portAlt').textContent=s.port;
      if(s.steamAppId)$('steamBtn').href='steam://run/'+s.steamAppId;
    }
    if(d.mods)$('modCount').textContent=d.mods.length;
  }

  // Vanilla presets by name; a widened small world (8400 x 1200) gets its own label.
  function sizeName(t){
    var k=t.width+'x'+t.height;
    var n={'4200x1200':'pequeno','6400x1800':'médio','8400x2400':'grande','8400x1200':'pequeno dobrado'}[k];
    return n?' ('+n+')':'';
  }
  // Progression order, names as the game shows them in pt-BR. Numbers are boss head
  // sprites (NPCID.Sets.BossHeadTextures); 'item:' uses an item sprite instead.
  var BOSSES=[
    ['kingSlime','Geleia Rei',7],['eyeOfCthulhu','Olho de Cthulhu',0],
    ['eaterOfWorlds','Devorador de Mundos',2],['brainOfCthulhu','Cérebro de Cthulhu',23],
    ['queenBee','Abelha Rainha',14],['skeletron','Esqueletron',19],['deerclops','Cervoclope',39],
    ['wallOfFlesh','Parede de Carne',22],['queenSlime','Geleia Rainha',38],['theTwins','Os Gêmeos',20],
    ['destroyer','O Destruidor',25],['skeletronPrime','Esqueletron Alfa',18],['plantera','Plantera',11],
    ['golem','Golem',5],['duke','Duque Peixe-dragão',4],['empress','Imperatriz da Luz',37],
    ['cultist','Cultista Lunático',24],['moonLord','Senhor da Lua',8]
  ];
  var EVENTS=[
    ['bloodMoon','Lua de Sangue','item:4271'],['goblins','Invasão dos Goblins','item:361'],
    ['oldOnesArmy','Exército do Antigo','item:3828'],['darkMage','Mago Sombrio',32],
    ['ogre','Ogro',33],['betsy','Betsy',34],['frostLegion','Legião Congelada','item:602'],
    ['pirates','Invasão Pirata','item:1315'],['flyingDutchman','Holandês Voador',26],
    ['eclipse','Eclipse Solar','item:2767'],['pumpkinMoon','Lua de Abóbora','item:1844'],
    ['mourningWood','Árvore da Morte',10],['pumpking','Reibóbora',13],
    ['frostMoon','Lua Congelada','item:1958'],['everscream','Everscream',3],
    ['santaNK1','Papai-Noel-NK1',17],['iceQueen','Rainha do Gelo',6],
    ['martians','Invasão Marciana','item:2797'],['martianSaucer','Disco Marciano',9],
    ['solarPillar','Pilar Solar',27],['vortexPillar','Pilar do Vórtice',28],
    ['nebulaPillar','Pilar da Nebulosa',29],['stardustPillar','Pilar de Poeira Estelar',30]
  ];
  function bossTile(b,done){
    var li=el('li','boss'+(done?' done':''));
    if(spritesOn.npc){
      var img=document.createElement('img');img.alt='';img.width=48;img.height=48;
      img.src=typeof b[2]==='number'?'/sprites/npc/boss_'+b[2]+'.png':'/sprites/item/'+String(b[2]).slice(5)+'.png';
      img.onerror=function(){img.remove();};
      li.appendChild(img);
    }
    li.appendChild(el('span','bn',b[1]));
    if(done){var mark=icon('check');mark.setAttribute('class','ic bs');li.appendChild(mark);}
    li.appendChild(el('span','sr-only',done?' (derrotado)':' (ainda não derrotado)'));
    return li;
  }
  var bossKey='';
  function renderBosses(p){
    if(!p||!p.downed)return;
    var key=JSON.stringify(p)+spritesOn.npc;
    if(key===bossKey)return;
    bossKey=key;
    var list=BOSSES;
    if(p.downed.eaterOfWorlds===undefined){
      // older server mod: one flag for either evil boss, credit the world's own evil
      p.downed[p.crimson?'brainOfCthulhu':'eaterOfWorlds']=!!p.downed.evilBoss;
    }
    var done=list.filter(function(b){return p.downed[b[0]];}).length;
    var bl=$('bossList'),ev=$('eventList');bl.textContent='';ev.textContent='';
    list.forEach(function(b){bl.appendChild(bossTile(b,!!p.downed[b[0]]));});
    EVENTS.forEach(function(b){ev.appendChild(bossTile(b,!!p.downed[b[0]]));});
    $('bossCount').textContent=done+'/'+list.length;
    $('bossFill').style.width=(done/list.length*100)+'%';
    $('bossBar').setAttribute('aria-label',done+' de '+list.length+' bosses derrotados');
    renderModBosses(p.modBosses||[]);
    $('bossPanel').hidden=false;
  }
  var MOD_NAMES={FargowiltasSouls:"Fargo's Souls",Fargowiltas:"Fargo's Mutant"};
  function renderModBosses(list){
    var box=$('modBossBox'),ul=$('modBossList');ul.textContent='';
    if(!list.length){box.hidden=true;return;}
    var mods=[];list.forEach(function(b){if(mods.indexOf(b.mod)<0)mods.push(b.mod);});
    $('modBossTitle').textContent='Bosses dos mods ('+mods.map(function(m){return MOD_NAMES[m]||m;}).join(', ')+')';
    list.forEach(function(b){
      var li=el('li','boss'+(b.downed?' done':'')+(b.kind!=='boss'?' minor':''));
      if(b.icon){
        var img=document.createElement('img');img.alt='';img.width=48;img.height=48;img.className='modhead';
        img.src='/sprites/modboss/'+b.icon+'.png';img.onerror=function(){img.remove();};li.appendChild(img);
      }
      li.appendChild(el('span','bn',b.name));
      if(b.kind==='miniboss')li.appendChild(el('span','bk','miniboss'));
      if(b.downed){var mark=icon('check');mark.setAttribute('class','ic bs');li.appendChild(mark);}
      li.appendChild(el('span','sr-only',b.downed?' (derrotado)':' (ainda não derrotado)'));
      ul.appendChild(li);
    });
    var done=list.filter(function(b){return b.downed;}).length;
    $('modBossCount').textContent=done+'/'+list.length;
    $('modBossFill').style.width=(done/list.length*100)+'%';
    $('modBossBar').setAttribute('aria-label',done+' de '+list.length+' bosses de mods derrotados');
    box.hidden=false;
  }

  function tick(){
    fetch('/api/status',{cache:'no-store'}).then(function(r){return r.json();})
      .then(apply).catch(function(){
        var gem=$('gem');gem.className='status-gem is-loading';$('gemText').textContent='sem conexão';
      });
  }

  // copy address
  function copyAddr(){
    var txt=$('addr').textContent.trim();
    var show=function(ok){var t=$('toast');t.textContent=ok?'Endereço copiado!':'Não deu pra copiar, selecione o IP e copie à mão';
      t.classList.toggle('err',!ok);t.classList.add('show');setTimeout(function(){t.classList.remove('show');},ok?1600:3200);};
    if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(txt).then(function(){show(true);},function(){show(false);});}
    else{var ta=document.createElement('textarea');ta.value=txt;document.body.appendChild(ta);ta.select();var ok=false;try{ok=document.execCommand('copy');}catch(e){}document.body.removeChild(ta);show(ok);}
  }
  $('copyBtn').addEventListener('click',copyAddr);

  // The sign stays on one line: when the address is wider than the space left
  // beside the label and the button, shrink its font to fit (down to a floor).
  var ADDR_MIN_PX=11;
  function fitAddr(){
    var a=$('addr');
    a.style.fontSize='';a.title='';            // back to the CSS size, then measure
    var max=parseFloat(getComputedStyle(a).fontSize);
    if(a.scrollWidth<=a.clientWidth)return;
    var px=Math.max(ADDR_MIN_PX,Math.floor(max*a.clientWidth/a.scrollWidth*2)/2);
    a.style.fontSize=px+'px';
    a.title=a.scrollWidth>a.clientWidth?a.textContent:'';   // floor reached: full address on hover
  }
  if(window.ResizeObserver)new ResizeObserver(fitAddr).observe($('sign'));
  else window.addEventListener('resize',fitAddr);
  if(document.fonts&&document.fonts.ready)document.fonts.ready.then(fitAddr);
  fitAddr();

  // relative "updated" refresh
  setInterval(function(){$('updated').textContent=fmtAgo(lastUpdated);},1000);

  tick();
  setInterval(tick,5000);
})();
