import assert from 'node:assert/strict';
import {test} from 'node:test';
import {botFaultPresentation} from '../src/services/botFaultPresentation.ts';
import type {TelegramBotPublicConfig} from '../src/services/apiTypes.ts';
const now=Date.UTC(2026,9,19);
const base:TelegramBotPublicConfig={configured:true,enabled:true,required:false,pinConfigured:true,source:'web',status:'ready',runtimeReady:true,credentialProbeOnly:false,connected:true,bot:null,lastConnectedAt:null,lastError:null,action:null};
test('runtime readiness and transport connectivity override a stale ready status',()=>{
 for(const patch of [{runtimeReady:false},{connected:false},{status:'error' as const,runtimeReady:false,connected:false},{status:'reconnecting' as const,actionCode:'BOT_WAIT_CONNECTION',connected:false}]){
  const fault=botFaultPresentation({...base,...patch},now);
  assert.equal(fault.offline,true);
  assert.equal(fault.retryBlockedReason,null);
  assert.equal(fault.action,'retryAction');
 }
});
test('safety and lifecycle blockers take precedence over reconnect eligibility',()=>{
 const rows:[Partial<TelegramBotPublicConfig>,string][]=[
  [{cleanupBlocked:true,busy:true,enabled:false},'cleanupBlocked'],
  [{actionCode:'BOT_REVIEW_REQUIRED'},'cleanupBlocked'],
  [{cleanupError:'BOT_CLEANUP_UNCONFIRMED'},'cleanupBlocked'],
  [{busy:true,nextRetryAt:new Date(now+30000).toISOString()},'busy'],
  [{nextRetryAt:new Date(now+30000).toISOString()},'waitAction'],
  [{status:'starting'},'waitAction'],
  [{retryAllowedAt:new Date(now+30000).toISOString()},'retryCooldown'],
  [{enabled:false},'disabledAction'],
  [{configured:false,enabled:false},'configureAction'],
 ];
 for(const [patch,reason] of rows){assert.equal(botFaultPresentation({...base,runtimeReady:false,connected:false,...patch},now).retryBlockedReason,reason);}
});
test('manual cooldown expiry unlocks an offline Bot without allowing a healthy Bot restart',()=>{
 const config={...base,connected:false,retryAllowedAt:new Date(now+30000).toISOString()};
 assert.equal(botFaultPresentation(config,now).retryBlockedReason,'retryCooldown');
 assert.equal(botFaultPresentation(config,now+30000).retryBlockedReason,null);
 const healthy=botFaultPresentation(base,now);
 assert.equal(healthy.offline,false);
 assert.equal(healthy.retryBlockedReason,'alreadyConnected');
 assert.equal(healthy.action,null);
});
