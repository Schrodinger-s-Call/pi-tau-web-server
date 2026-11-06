import asyncio, tempfile, shutil, json, base64, urllib.request, urllib.error, os
from pathlib import Path
from smoke.run_tau import workspaces
from smoke.run_tau.config import REPO, save, snapshot
from smoke.run_tau.supervisor import Environment, Supervisor, cleanup
from smoke.run_tau.runtime import podman, LABEL
from smoke.run_tau.verify import free_port

async def main():
    with tempfile.TemporaryDirectory(prefix='tau-http-joint-') as directory:
        root = Path(directory)
        source = root / 'source'
        for folder in ('agents/scripts/config', 'agents/extensions', 'workspace', 'templates'):
            (source / folder).mkdir(parents=True)
        (source / 'workspace/AGENTS.md').write_text('Offline fixture only.')
        shutil.copyfile(REPO / 'tests/tau_fixture_provider.mjs', source / 'agents/extensions/fixture.mjs')
        (source / 'agents/extensions/identity.mjs').write_text("export default function(pi) { pi.registerCommand('fixture-new-history', { description: 'Start fixture history', handler: async (_args, ctx) => { await ctx.waitForIdle(); await ctx.newSession(); } }); }")
        profile = root / 'profile'
        save(profile / 'settings.json', {'defaultProvider':'tau-fixture','defaultModel':'echo','extensions':['/workspace/.agents/extensions/fixture.mjs','/workspace/.agents/extensions/identity.mjs']})
        snapshot(root, 'v1', source)
        (source / 'workspace/AGENTS.md').write_text('Offline version two.')
        snapshot(root, 'v2', source)
        deployment = Supervisor(root).deployment
        envs = []
        async def request(env, route, body=None, method=None, raw=False):
            def perform():
                auth = base64.b64encode(f'{env.name}:fixture-only'.encode()).decode()
                headers = {'Authorization': 'Basic ' + auth, 'Content-Type':'application/json'}
                req = urllib.request.Request(f'http://127.0.0.1:{env.cfg["port"]}'+route, data=None if body is None else json.dumps(body).encode(), headers=headers, method=method)
                try:
                    with urllib.request.urlopen(req, timeout=265) as reply:
                        value = reply.read()
                        return reply.status, value.decode() if raw else json.loads(value)
                except urllib.error.HTTPError as error:
                    return error.code, json.loads(error.read())
            return await asyncio.to_thread(perform)
        try:
            for name in ('alice','bob'):
                workspaces.initialize_user(root,name,account=name,pi_image='172.20.2.109:5000/gpas/agent-bundle:1.1.0',tau_image='localhost/pi-tau-web-server:workspace-candidate',pi_source=profile,port=free_port(),gpas=False)
                save(root/f'environments/{name}/config/tau-auth.json',{'username':name,'password':'fixture-only'})
                for space in ('debug','exp1'): workspaces.create(root,name,space,'v1')
                env = Environment(root,name,deployment)
                envs.append(env)
                await env.start()
            alice,bob=envs
            status,directory = await request(alice,'/api/workspaces')
            assert status==200 and len(directory['workspaces'])==2, directory
            print('PASS real directory query with strict protocol',flush=True)
            async def create(env,space):
                status,response=await request(env,'/api/live-sessions',{'workspace_id':space})
                assert status==200, response
                return response['session']
            a=await create(alice,'debug'); b=await create(alice,'exp1'); other=await create(bob,'debug')
            record=alice.records.get(a['run']['run_id'])
            assert record['seq']==0 and a['pi_session_id']==record['session_id']
            assert a['run']['actual_bundle']['name']=='v1'
            print('PASS ready with delayed new history and persisted seq 0',flush=True)
            status,models=await request(alice,'/api/rpc',{'type':'get_available_models','workspace_id':'debug'})
            assert status==200 and models['success'], models
            print('PASS real short command started/completed and model output',flush=True)
            async def rpc(session,kind,**fields):
                status,response=await request(alice,'/api/rpc',{'sessionId':session['id'],'type':kind,**fields})
                assert status==200 and response.get('success'), response
                return response.get('data',{})
            await rpc(a,'prompt',message='hello')
            for _ in range(100):
                await asyncio.sleep(.1)
                state=await rpc(a,'get_state',refresh=True)
                if not state.get('isStreaming'): break
            status,exported=await request(alice,'/api/rpc',{'type':'export_html','sessionId':a['id']})
            assert exported['success'],exported
            status,html=await request(alice,exported['data']['downloadUrl'],raw=True)
            assert status==200 and '<html' in html.lower()
            print('PASS prompt and HTML export through Tau HTTP',flush=True)
            upload={'sessionId':a['id'],'name':'owner.txt','data':base64.b64encode(b'alice-debug').decode()}
            assert (await request(alice,'/api/file/upload',upload))[0]==200
            status,contents=await request(alice,'/api/file/download?sessionId='+a['id']+'&path=/workspace/owner.txt',raw=True)
            assert contents=='alice-debug'
            assert (await request(alice,'/api/file/download?sessionId='+b['id']+'&path=/workspace/owner.txt'))[0]==400
            assert (await request(bob,'/api/run-info?run_id='+a['run']['run_id']))[0]==400
            print('PASS file and cross-user run isolation',flush=True)
            tree=await rpc(a,'get_tree')
            def flatten(nodes):
                for node in nodes:
                    yield node['entry']
                    yield from flatten(node.get('children',[]))
            user=next(e for e in flatten(tree['tree']) if e.get('message',{}).get('role')=='user')
            await rpc(a,'fork',entryId=user['id'])
            await rpc(a,'prompt',message='write fork')
            for _ in range(100):
                await asyncio.sleep(.1)
                changed=alice.records.get(a['run']['run_id'])
                if changed['seq']>=1: break
            assert changed['seq']>=1 and changed['session_id']!=record['session_id'],changed
            print('PASS real fork identity persisted by run_tau',flush=True)
            await rpc(a,'prompt',message='/fixture-new-history')
            await rpc(a,'prompt',message='persist extension history')
            for _ in range(100):
                await asyncio.sleep(.1)
                extension_record=alice.records.get(a['run']['run_id'])
                if extension_record['seq']>changed['seq']: break
            assert extension_record['seq']>changed['seq'] and extension_record['session_id']!=changed['session_id'],extension_record
            print('PASS extension-driven new history and delayed persistence',flush=True)
            browser = await asyncio.create_subprocess_exec('node', str(Path(__file__).with_name('workspace-browser.ts')), f'http://127.0.0.1:{alice.cfg["port"]}', a['id'], a['run']['run_id'])
            assert await browser.wait()==0
            workspaces.switch(root,'alice','exp1','v2')
            new=await create(alice,'exp1')
            assert new['run']['actual_bundle']['name']=='v2' and alice.records.get(b['run']['run_id'])['actual_bundle']['name']=='v1'
            print('PASS current bundle update preserves active run version',flush=True)
            status,current=await request(alice,'/api/live-sessions')
            active=next(item for item in current['sessions'] if item['id']==a['id'])
            status,reused=await request(alice,'/api/live-sessions/resume',{'workspace_id':'debug','filePath':active['sessionFile']})
            assert status==200 and reused['session']['run']['run_id']==a['run']['run_id'],reused
            await request(alice,'/api/live-sessions/'+a['id'],method='DELETE')
            for _ in range(100):
                if alice.records.get(a['run']['run_id'])['state']!='running': break
                await asyncio.sleep(.1)
            status,resumed=await request(alice,'/api/live-sessions/resume',{'workspace_id':'debug','filePath':active['sessionFile']})
            assert status==200 and resumed['session']['run']['run_id']!=a['run']['run_id'],resumed
            assert resumed['session']['pi_session_id']==active['pi_session_id']
            print('PASS live resume reuses Pi and stopped history starts a new run with the same identity',flush=True)
            await alice.stop()
            assert (await request(bob,'/api/live-sessions'))[0]==200
            print('PASS stopping one user keeps the other user alive',flush=True)
        finally:
            for env in envs: await env.stop()
            await cleanup(deployment)
        assert not await podman('ps','-aq','--filter',f'label={LABEL}={deployment}')
        print('PASS isolated container cleanup',flush=True)

asyncio.run(main())
