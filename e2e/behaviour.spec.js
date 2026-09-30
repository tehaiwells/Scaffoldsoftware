import {test,expect} from '@playwright/test';
// Behaviour checks that used to be source-text tests (unit tests that read design.css, game.css, operations.js or game.js and matched
// snippets of code). Here the real browser answers instead: the page's own stylesheets, as served, applied to small pieces of the
// app's markup (what a person would see), and the running app's wiring (what it does), so a refactor that keeps the behaviour passes
// and broken behaviour fails even when the code snippet is still there.

// The page's own stylesheets as index.html links them, on a page served by the app (so its CSP applies too), with the given body.
async function styled(page,body,{width=1280,height=900,bodyClass=''}={}){
  const html=await (await page.request.get('/')).text(),links=[...html.matchAll(/<link rel="stylesheet" href="[^"]+">/g)].map(m=>m[0]).join('');
  if(!page.url().endsWith('/health'))await page.goto('/health');
  await page.setViewportSize({width,height});
  await page.setContent(`<!doctype html><html lang="en"><head><meta charset="utf-8">${links}</head><body class="${bodyClass}">${body}</body></html>`);
}
const css=(page,selector,prop,pseudo=null)=>page.evaluate(([s,p,ps])=>{const el=document.querySelector(s);if(!el)throw new Error('no element '+s);return getComputedStyle(el,ps)[p];},[selector,prop,pseudo]);
const shown=(page,selector)=>page.evaluate(s=>[...document.querySelectorAll(s)].map(el=>getComputedStyle(el).display!=='none'),selector);
// Sets an element's size through the CSSOM (allowed by the CSP, unlike a style attribute).
const size=(page,selector,width)=>page.evaluate(([s,w])=>{document.querySelector(s).style.width=w+'px';},[selector,width]);

test('stylesheets: what each part of the app looks like at desktop and phone widths, and in print',async({page})=>{
  // Alerts (was alerts-ui.test.js): the drawer hides with [hidden]; the Home strip keeps to one row: 4, then 3, then 2 alerts as the window narrows.
  const strip='<div class="al-drawer" hidden>Alerts</div><div class="al-strip-list">'+'<div class="al-item">a</div>'.repeat(5)+'</div>';
  await styled(page,strip,{width:1600});expect(await css(page,'.al-drawer','display')).toBe('none');expect((await shown(page,'.al-item')).slice(0,4)).toEqual([true,true,true,true]);
  await styled(page,strip,{width:1280});expect((await shown(page,'.al-item')).slice(0,4)).toEqual([true,true,true,false]);
  await styled(page,strip,{width:1000});expect((await shown(page,'.al-item')).slice(0,3)).toEqual([true,true,false]);

  // Scheduled returns (was collections-ui.test.js): a return card looks different from a delivery card, and its steps are a row of five.
  await styled(page,'<div class="page-schedule"><div class="sch-card" id="plain">d</div><div class="sch-card rt-card" id="rt">r</div><ol class="rt-steps"><li>1</li><li>2</li><li>3</li><li>4</li><li>5</li></ol></div>');
  expect(await css(page,'#rt','backgroundImage')).toContain('linear-gradient');expect(await css(page,'#rt','backgroundImage')).not.toBe(await css(page,'#plain','backgroundImage'));
  expect((await css(page,'.rt-steps','gridTemplateColumns')).split(' ')).toHaveLength(5);

  // The crew phone view (was crew.test.js): a centred 640 px column on a desktop, big buttons, phone rules down to 320 px; hover only
  // changes a button that can be pressed, and the open button keeps its light fill under the pointer.
  const crew='<div class="content"><div id="view"><div class="page-crew"><button type="button" class="cw-big-btn" id="b1">Go</button><button type="button" class="cw-big-btn is-open" id="open">Open</button><button type="button" class="cw-big-btn" id="off" disabled>Off</button><div class="cw-portrait"></div><button type="button" class="cw-back"><span class="cw-back-long">Back to Workers</span><span class="cw-back-short">Back</span></button></div></div></div>';
  await styled(page,crew,{width:1280});
  const box=await page.locator('.page-crew').boundingBox();expect(box.width).toBeLessThanOrEqual(640);expect(Math.abs(box.x-(1280-box.x-box.width))).toBeLessThanOrEqual(20);
  expect(parseFloat(await css(page,'#b1','minHeight'))).toBeGreaterThanOrEqual(48);
  // (buttons fade their colour, so the hovered colour is waited for)
  const bg=id=>css(page,id,'backgroundColor');
  expect(await bg('#open')).toBe('rgb(217, 245, 107)');await page.hover('#open');await expect.poll(()=>bg('#open')).toBe('rgb(205, 234, 92)');
  const idle=await bg('#b1');await page.hover('#b1');await expect.poll(()=>bg('#b1')).toBe('rgb(43, 93, 68)');expect(idle).not.toBe('rgb(43, 93, 68)');
  const offBg=await bg('#off');await page.hover('#off',{force:true});await page.waitForTimeout(400);expect(await bg('#off')).toBe(offBg);
  const portrait=await css(page,'.cw-portrait','width');
  for(const w of [650,360]){await styled(page,crew,{width:w,height:800});expect(parseFloat(await css(page,'#b1','minHeight'))).toBeGreaterThanOrEqual(48);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   expect(parseFloat(await css(page,'.cw-portrait','width'))).toBeLessThan(parseFloat(portrait));expect(await shown(page,'.cw-back-long')).toEqual([w>360]);expect(await shown(page,'.cw-back-short')).toEqual([w<=360]);}

  // The game board (was game-ui.test.js and sitefinish.test.js): no stillage and crew tags on the map, parked trucks carry no tag unless
  // followed, a smaller top bar on a phone, and the round Undo button of the site pop.
  const board='<div class="gm-board"><svg class="world-svg"><text class="tg" x="5" y="5">A1</text></svg><div class="wm-truck parked" id="parked"><span class="wm-ttag">Truck</span></div><div class="wm-truck parked followed" id="followed"><span class="wm-ttag">Truck</span></div><div class="wm-truck" id="driving"><span class="wm-ttag">Big truck</span></div></div><div class="gm-top">top</div><div class="gm-pop sf-pop"><button type="button" class="sf-undo">Undo</button></div>';
  await styled(page,board);
  expect(await css(page,'.tg','display')).toBe('none');expect(await shown(page,'.wm-ttag')).toEqual([false,true,true]);
  expect([await css(page,'.sf-undo','borderTopLeftRadius'),await css(page,'.sf-undo','backgroundColor')]).toEqual(['999px','rgb(22, 56, 44)']);const deskTop=await css(page,'.gm-top','height');
  await styled(page,board,{width:375,height:812});expect(await css(page,'.gm-top','height')).toBe('48px');expect(deskTop).not.toBe('48px');

  // Global search (was global-search.test.js): on a phone the open search is a sheet over the whole screen.
  await styled(page,'<div class="gs sheet"><div class="gs-field"><div class="gs-box">search</div></div></div>',{width:375,height:812});
  expect(await css(page,'.gs-field','position')).toBe('fixed');const field=await page.locator('.gs-field').boundingBox();expect([field.x,field.y,field.width]).toEqual([0,0,375]);

  // Material tiles and the hover card (was material-card.test.js): fixed 86 px tiles with the size and variant drawn by CSS, off-screen
  // tiles skipped with an estimate equal to the tile height (so a restored scroll lands on the same tile), and a card that never takes a click.
  const tiles=Array.from({length:30},(_,i)=>`<button type="button" class="tile" data-size="2 m" data-variant="QS"><span class="tile-icon"></span><span class="tile-name">T${i+1}</span></button>`).join('');
  await styled(page,`<div class="stockpile"><div class="tile-grid">${tiles}</div></div><div class="mat-card"><div class="mc-head">h</div><div class="mc-body">b</div><div class="mc-total">t</div></div><div class="mat-card" id="gone" hidden>x</div>`);
  expect(await css(page,'.tile','height')).toBe('86px');expect(await css(page,'.tile','content','::after')).toBe('"2 m"');expect(await css(page,'.tile','content','::before')).toBe('"QS"');
  expect(await page.evaluate(()=>[...document.querySelectorAll('.tile')].map(t=>getComputedStyle(t).contentVisibility).lastIndexOf('visible'))).toBe(24);
  expect(await page.evaluate(()=>getComputedStyle(document.querySelectorAll('.tile')[25]).containIntrinsicHeight)).toContain('86px');
  expect(await page.evaluate(()=>Math.min(...[...document.querySelectorAll('.tile')].slice(0,5).map(t=>t.getBoundingClientRect().width)))).toBeGreaterThanOrEqual(66);
  expect([await css(page,'.tile-icon','width'),await css(page,'.tile-icon','height')]).toEqual(['32px','32px']);
  expect([await css(page,'.mat-card','position'),await css(page,'.mat-card','pointerEvents'),await css(page,'.mat-card','flexDirection'),await css(page,'.mat-card','maxHeight')]).toEqual(['fixed','none','column','884px']);
  expect(await css(page,'#gone','display')).toBe('none');expect([await css(page,'.mc-body','overflow'),await css(page,'.mc-body','minHeight')]).toEqual(['hidden','0px']);

  // Shape editor and corner badges (was review-ui.test.js): the badges never take a click; the fixture row is four even columns in a
  // narrow column and one line where there is room; a side's length stays with its unit; on a narrow column the actions take their own line.
  await styled(page,'<svg><g class="corner-number"><circle r="5" cx="9" cy="9"></circle></g></svg><div class="shape-rest"><div class="shape-fixture"><select><option>Gate</option></select><input type="text" value="Gate"><input type="number"><input type="number"><button type="button">Add</button><button type="button">X</button></div><ul class="shape-sides"><li><span class="side-len"><input type="number"> mm</span><span class="side-actions">actions</span></li></ul><table class="shape-corners"><tr><td>1</td></tr></table></div>',{width:375,height:812});
  expect(await css(page,'.corner-number','pointerEvents')).toBe('none');expect(await css(page,'.corner-number circle','pointerEvents')).toBe('none');
  expect(await css(page,'.shape-corners','minWidth')).toBe('0px');expect(await css(page,'.side-len','whiteSpace')).toBe('nowrap');
  await size(page,'.shape-rest',400);expect((await css(page,'.shape-fixture','gridTemplateColumns')).split(' ')).toHaveLength(4);expect(await css(page,'.side-actions','flexBasis')).toBe('100%');
  expect(await page.evaluate(()=>{const f=document.querySelector('.shape-fixture');return f.scrollWidth<=f.clientWidth;})).toBe(true);
  await page.setViewportSize({width:1280,height:900});await size(page,'.shape-rest',600);expect((await css(page,'.shape-fixture','gridTemplateColumns')).split(' ')).toHaveLength(6);expect(await css(page,'.side-actions','flexBasis')).not.toBe('100%');

  // Today (was today.test.js): its rules apply only on the Today page (the same class elsewhere is untouched), with 44 px targets and phone rules.
  const today='<div class="page-today tdh"><button type="button" class="td-btn" id="in1">Go</button><button type="button" class="tdh-btn" id="in2">Go</button><div class="tk-band-art">art</div><div class="tdh-head"><div class="tdh-head-art">art</div></div></div><button type="button" class="td-btn" id="out1">Go</button><button type="button" class="tdh-btn" id="out2">Go</button>';
  await styled(page,today);
  expect([await css(page,'#in1','minHeight'),await css(page,'#in2','minHeight')]).toEqual(['44px','44px']);
  expect(await css(page,'#out1','minHeight')).not.toBe('44px');expect(await css(page,'#out2','minHeight')).not.toBe('44px');
  expect(await shown(page,'.tk-band-art')).toEqual([true]);expect(await shown(page,'.tdh-head-art')).toEqual([true]);
  await styled(page,today,{width:700,height:900});expect(await shown(page,'.tdh-head-art')).toEqual([false]);expect(await shown(page,'.tk-band-art')).toEqual([true]);
  await styled(page,today,{width:640,height:900});expect(await shown(page,'.tk-band-art')).toEqual([false]);

  // Print (was print.test.js): only the sheet prints, without its toolbar, on A4 portrait.
  await styled(page,'<main id="app">the app</main><div class="pr-host"><div class="pr-shell"><div class="pr-toolbar">Print</div><div class="pr-sheet">The sheet</div></div></div>',{bodyClass:'pr-open'});
  expect(await css(page,'#app','display')).not.toBe('none');
  await page.emulateMedia({media:'print'});
  expect(await css(page,'#app','display')).toBe('none');expect(await css(page,'.pr-host','display')).toBe('block');expect(await css(page,'.pr-toolbar','display')).toBe('none');
  const pdf=(await page.pdf({preferCSSPageSize:true})).toString('latin1'),box0=/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/.exec(pdf);
  expect(box0,'a page size in the PDF').toBeTruthy();expect(Math.round(Number(box0[1]))).toBe(595);expect(Math.round(Number(box0[2]))).toBe(842);// A4 portrait in points
  await page.emulateMedia({media:null});
});

test('the running app: the board is patched by its poll, the search box keeps the poll going, and nothing breaks the content security policy',async({page})=>{
  test.setTimeout(120000);
  await page.addInitScript(()=>{window.__csp=[];document.addEventListener('securitypolicyviolation',e=>window.__csp.push(e.violatedDirective+' '+(e.blockedURI||'inline')+' at '+e.sourceFile+':'+e.lineNumber));});
  const polls=[];page.on('request',r=>{const u=new URL(r.url());if(u.pathname==='/api/state')polls.push(u.search);});
  const pollsAfter=async(n)=>{const start=polls.length;await expect.poll(()=>polls.length-start,{timeout:30000}).toBeGreaterThanOrEqual(n);return polls.slice(start);};
  await page.goto('/');
  // the installable app: the page links its manifest, theme colour and home-screen icon
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href','/manifest.webmanifest');await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content','#16382c');await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('href','/icons/apple-touch-icon.png');
  await page.getByRole('textbox',{name:'Company name',exact:true}).fill('Behaviour DEMO');await page.getByRole('textbox',{name:'Your name',exact:true}).fill('Test Owner');
  await page.getByRole('textbox',{name:'Email',exact:true}).fill(`behaviour-${Date.now()}@example.test`);await page.getByRole('textbox',{name:'Password',exact:true}).fill('Local-demo-test-2026!');
  await page.getByRole('button',{name:'Create company',exact:true}).click();
  // an owner opens on the game board
  await expect(page.getByRole('heading',{level:1,name:'How big is your yard?'})).toBeVisible({timeout:45000});await page.locator('[data-gm-size="S"]').click();
  const bar=page.getByRole('navigation',{name:'What do you want to do?'});await expect(bar).toBeVisible({timeout:45000});
  // the board's poll brings the map block and patches the board in place (the same element stays; nothing is rebuilt)
  await page.evaluate(()=>{document.querySelector('.game-mode').__kept=true;});
  const seen=await pollsAfter(2);expect(seen.some(q=>q.includes('world='))).toBe(true);
  expect(await page.evaluate(()=>document.querySelector('.game-mode')?.__kept===true)).toBe(true);
  await expect(page.locator('.gm-board .world-svg').first()).toBeVisible();
  // Send with nothing in the yard says so, and opens no box to name a site (that waits until there is something to send)
  await bar.getByRole('button',{name:'Send',exact:true}).click();await expect(page.getByText('Your yard is empty').first()).toBeVisible();
  await expect(page.getByRole('textbox',{name:'Site name'})).toHaveCount(0);
  // the Office drawer from the board: an owner sees Hire, next to Reports
  await page.getByRole('button',{name:'Office',exact:true}).first().click();const nav=page.getByRole('navigation',{name:'Main navigation'});
  await expect(nav.getByRole('button',{name:'Hire',exact:true})).toBeVisible();await expect(nav.getByRole('button',{name:'Reports',exact:true})).toBeVisible();
  // an Office page: the search box is in the header; typing shows results and does not pause the poll; a poll keeps the results open
  await nav.getByRole('button',{name:'Stock ledger',exact:true}).click();await expect(page.getByRole('heading',{level:1,name:/Stock/})).toBeVisible();
  const search=page.locator('body>header').getByRole('combobox');await expect(search).toBeVisible();
  await search.fill('yard');await expect(page.getByRole('listbox')).toBeVisible();
  await pollsAfter(2);await expect(search).toBeFocused();await expect(page.getByRole('listbox')).toBeVisible();
  await search.press('Escape');
  await page.getByRole('button',{name:'Back to the yard',exact:true}).click();await expect(bar).toBeVisible();
  // the Add stock slider can be dragged without stopping the poll either
  const live=page.locator('[data-gm-live]').first();if(await live.count()){await live.focus();await pollsAfter(1);}
  // leaving the Office pages for Account takes the search box away with them
  await page.getByRole('button',{name:'Office',exact:true}).first().click();await page.locator('#settings').click();
  await expect(page.getByRole('heading',{name:'Backups'})).toBeVisible();await expect(search).toBeHidden();
  expect(await page.evaluate(()=>window.__csp)).toEqual([]);
});
