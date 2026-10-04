const SETTINGS_SCHEMA={
 general:[
  {key:'startMinimized',label:'Start minimized to tray',type:'toggle',default:false},
  {key:'closeToTray',label:'Keep Rust Forge in the tray when closed',type:'toggle',default:true},
  {key:'rememberLastServer',label:'Remember the last selected server',type:'toggle',default:true},
  {key:'autoUpdateRust',label:'Update Rust during autonomous setup',type:'toggle',default:true},
  {key:'autoUpdateUmod',label:'Synchronize uMod after Rust updates',type:'toggle',default:true},
  {key:'autoRestartCrashed',label:'Automatically recover crashed servers',type:'toggle',default:true},
  {key:'autoPluginDependencies',label:'Resolve required plugin dependencies automatically',type:'toggle',default:true},
  {key:'autoPluginUpdates',label:'Apply plugin updates automatically when checked',type:'toggle',default:false}
 ],
 automation:[
  {key:'pluginUpdateCheckHours',label:'Plugin update check interval',type:'range',min:1,max:24,step:1,suffix:' h',default:6},
  {key:'downloadConcurrency',label:'Background download concurrency',type:'range',min:1,max:4,step:1,suffix:'',default:2},
  {key:'rconReconnectMs',label:'RCON reconnect delay',type:'range',min:1000,max:10000,step:500,suffix:' ms',default:3000},
  {key:'schedulerPollMs',label:'Automation scheduler interval',type:'range',min:5000,max:60000,step:5000,suffix:' ms',default:15000}
 ],
 network:[
  {key:'playitAutoStart',label:'Automatically start the managed Playit agent when a server uses Playit mode',type:'toggle',default:true}
 ],
 performance:[
  {key:'consoleBuffer',label:'Live console line buffer',type:'range',min:500,max:15000,step:250,suffix:' lines',default:3000},
  {key:'statusPollMs',label:'Runtime status refresh interval',type:'range',min:750,max:5000,step:250,suffix:' ms',default:1500},
  {key:'telemetryIntervalMs',label:'Process telemetry interval',type:'range',min:1000,max:10000,step:500,suffix:' ms',default:2000}
 ]
}; module.exports={SETTINGS_SCHEMA};
