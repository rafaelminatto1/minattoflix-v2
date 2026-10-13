async page => {
 await page.unroute('**/api/**');
 const assert = (condition, message) => { if (!condition) throw new Error(message); };
 const profileId='11111111-1111-4111-8111-111111111111';
 const image='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="#293647"/><text x="25" y="220" fill="white" font-size="28">MINATTOFLIX</text></svg>');
 const catalog=Array.from({length:65},(_,index)=>{
  const id=`22222222-2222-4222-8222-${String(index+1).padStart(12,'0')}`;
  const audio={id:'audio-'+index,media_file_id:'file-'+index,source_type:'embedded',track_index:0,language_code:'pt-BR',label:'Português',codec:'AAC',channels:'2.0',is_default:true};
  return {id,type:'movie',title:index===0?'Ação no Coração':`Filme ${String(index+1).padStart(2,'0')}`,original_title:'Action',slug:'filme-'+index,release_year:2020+index%6,overview:'Uma aventura de teste.',poster_url:image,backdrop_url:image,rating:7+index%3,age_rating:'L',runtime_minutes:90,is_featured:index===0,created_at:new Date(2026,9,11-index).toISOString(),cast_info:['José Silva'],genres:[{id:1,name:'Ação',slug:'acao-aventura'}],files:[{id:'file-'+index,media_item_id:id,provider:'gdrive',filename:'filme.mkv',container:'mkv',video_codec:'H264',audio_channels:'2.0',is_dual_audio:false,resolution:index%2===0?'2160p':'1080p',dynamic_range:'SDR',size_bytes:1000000,streamUrl:'/fixture-video.mp4',audioTracks:[audio],subtitleTracks:[]}],audioTracks:[audio],subtitleTracks:[],seasons:[],progress:index===0?{id:'progress',profile_id:profileId,media_item_id:id,position_seconds:100,duration_seconds:5400,is_completed:false,updated_at:new Date().toISOString()}:null,inMyList:false,isAvailable:true,detailsLoaded:false};
 });
 const data={profiles:[{id:profileId,name:'Teste',avatar_url:image,is_kids:false,preferred_audio_lang:'pt-BR',preferred_subtitle_lang:'off'}],activeProfileId:profileId,storageSources:[],genres:[],catalog};
 let failList=false, bootstrapCalls=0, detailCalls=0;
 const errors=[]; page.on('pageerror', error=>errors.push(error.message));
 await page.route('**/api/**',async route=>{
  const url={pathname:route.request().url().split('?')[0].replace(/^https?:\/\/[^/]+/, '')};
  if(url.pathname==='/api/bootstrap') {bootstrapCalls++;return route.fulfill({json:data});}
  if(url.pathname.endsWith('/details')) {detailCalls++;return route.fulfill({json:{...data,catalog:[{...catalog.find(item=>url.pathname.includes(item.id)),detailsLoaded:true}]}});}
  if(url.pathname==='/api/my-list/toggle') return route.fulfill({status:failList?500:200,json:{ok:!failList}});
  if(url.pathname.startsWith('/api/progress/')) return route.fulfill({json:{ok:true}});
  return route.fulfill({json:{}});
 });
 await page.setViewportSize({width:1440,height:900});
 await page.goto('http://127.0.0.1:5173');
 await page.getByRole('heading',{name:'Continuar assistindo como Teste'}).waitFor();
 const initialBootstrapCalls=bootstrapCalls;
 const carousel=page.getByRole('region',{name:'Adicionados Recentemente'});
 assert(await carousel.evaluate(el=>el.scrollLeft)===0,'Carousel should start at zero');
 const prev=page.locator('button[aria-label="Títulos anteriores em Adicionados Recentemente"]');
 assert(await prev.isDisabled(),'Previous arrow should be disabled initially');
 await page.getByRole('button',{name:'Próximos títulos em Adicionados Recentemente'}).click();
 await page.waitForTimeout(700);
 assert(await carousel.evaluate(el=>el.scrollLeft)>0,'Carousel should move');
 await carousel.focus();await page.keyboard.press('Home');
 assert(await carousel.evaluate(el=>el.scrollLeft)<3,'Home should restore carousel start');
 await page.evaluate(()=>window.scrollTo(0,1000));await page.waitForTimeout(150);
 const homePosition=await page.evaluate(()=>window.scrollY);
 await page.getByRole('button',{name:'Filmes',exact:true}).first().click();
 assert(await page.evaluate(()=>window.scrollY)<3,'New section should start at top');
 assert(await page.locator('.catalog-grid-card').count()===48,'Grid should initially render 48 cards');
 await page.getByRole('button',{name:'Mostrar mais títulos'}).click();
 assert(await page.locator('.catalog-grid-card').count()===65,'Load more should append titles');
 await page.getByRole('combobox',{name:'Qualidade'}).selectOption('2160p');
 assert(await page.locator('.catalog-grid-card').count()===33,'Quality filter should select 4K titles');
 await page.getByRole('button',{name:'Limpar filtros'}).click();
 await page.getByRole('button',{name:'Início',exact:true}).first().click();await page.waitForTimeout(150);
 assert(Math.abs(await page.evaluate(()=>window.scrollY)-homePosition)<5,'Home scroll position should be restored');
 await page.getByRole('button',{name:'Mais informações',exact:true}).click();
 await page.getByRole('dialog',{name:'Detalhes de Ação no Coração'}).waitFor();
 assert(await page.evaluate(()=>document.body.style.overflow)==='hidden','Dialog should lock background scrolling');
 assert(detailCalls===1,'Details should load on demand');
 await page.keyboard.press('Shift+Tab');
 assert(await page.getByRole('dialog').evaluate(el=>el.contains(document.activeElement)),'Focus must stay inside dialog');
 await page.keyboard.press('Escape');
 assert(await page.getByRole('dialog').count()===0,'Escape should close dialog');
 assert(await page.evaluate(()=>document.body.style.overflow)!=='hidden','Body scroll should be restored');
 failList=true;
 await page.getByRole('button',{name:'Adicionar à Minha Lista',exact:true}).first().click();
 await page.getByRole('alert').waitFor();
 assert(await page.getByRole('button',{name:'Adicionar à Minha Lista',exact:true}).first().isVisible(),'Failed list update should rollback');
 await page.getByRole('button',{name:'Fechar aviso'}).click();
 await page.getByRole('button',{name:'Remover de Continuar assistindo'}).click();
 await page.waitForTimeout(150);
 assert(await page.getByRole('heading',{name:'Continuar assistindo como Teste'}).count()===0,'Removing progress should remove the row');
 await page.screenshot({path:'docs/ui-desktop-validation.png'});
 await page.setViewportSize({width:390,height:844});
 await page.getByRole('button',{name:'Buscar no catálogo'}).click();
 await page.getByRole('textbox',{name:'Buscar títulos, atores e idiomas'}).fill('acao coracao');
 await page.waitForTimeout(150);
 assert(await page.locator('.catalog-grid-card').count()===1,'Accent-insensitive search should find one title');
 assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'Mobile page must not overflow horizontally');
 await page.screenshot({path:'docs/ui-mobile-validation.png'});
 for (const width of [320,390,640,768,1024,1440]) { await page.setViewportSize({width,height:844}); assert(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth), 'Horizontal overflow at '+width); }
 assert(bootstrapCalls===initialBootstrapCalls,'UI operations must not reload the bootstrap');
 assert(errors.length===0,'Browser errors: '+errors.join('; '));
 return {passed:true,checks:['carousel boundaries and keyboard','section scroll restoration','48-card pagination','quality filter','lazy details','dialog focus and Escape','failed list rollback','remove progress','mobile accented search and width'],bootstrapCalls,detailCalls};
}


