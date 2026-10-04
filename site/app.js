const cfg=window.RUST_FORGE_SITE||{};
const $=s=>document.querySelector(s);
const setLink=(id,url)=>{const e=$(id);if(e)e.href=url||'#'};
setLink('#githubTop',cfg.source);setLink('#openGithub',cfg.source);setLink('#sourceLink',cfg.source);setLink('#releasesCard',cfg.releases);setLink('#pagesLink',cfg.pages);
async function latestRelease(){
  if(!cfg.repository)return null;
  const res=await fetch(`https://api.github.com/repos/${cfg.repository}/releases/latest`,{headers:{Accept:'application/vnd.github+json'}});
  if(!res.ok)throw new Error(`GitHub API ${res.status}`);
  const release=await res.json();
  const setup=(release.assets||[]).find(a=>/-Setup-x64\.exe$/i.test(a.name||''));
  const portable=(release.assets||[]).find(a=>/-portable-x64\.exe$/i.test(a.name||''));
  return {release,setup,portable};
}
latestRelease().then(({release,setup,portable})=>{
  const version=(release.tag_name||'').replace(/^v/i,'');
  $('#releaseBadge').textContent=`Latest: v${version}`;
  $('#releaseDate').textContent=release.published_at?new Date(release.published_at).toLocaleDateString():'';
  const use=(id,a)=>{const e=$(id);if(!e)return;if(a)e.href=a.browser_download_url;else{e.href=cfg.releases||'#';e.textContent='View release assets'}};
  use('#downloadSetup',setup);use('#setupCard',setup);use('#downloadPortable',portable);use('#portableCard',portable);
}).catch(()=>{$('#releaseBadge').textContent='Open GitHub Releases for the latest build.';});
