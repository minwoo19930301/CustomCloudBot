#!/usr/bin/python3
"""Root-owned release command: only current main of the operator-pinned repository."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
from urllib.parse import urlsplit

CONFIG_PATH = Path('/etc/openclaw/deployment.json')
COMPOSE_PATH = Path('/etc/openclaw/compose.yml')


def validate_config(value):
    required = {'repository', 'checkout_root', 'deployment_user',
                'shared_desktop_room', 'shared_storage_root', 'public_origin',
                'compose_project', 'desktop_service'}
    if not isinstance(value, dict) or not required.issubset(value):
        raise ValueError('Explicit operator deployment configuration is required')
    if set(value) - required - {'run_command_user'}:
        raise ValueError('Unknown deployment configuration field')
    patterns = {
        'repository': r'[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*',
        'deployment_user': r'[a-z_][a-z0-9_-]{0,31}',
        'compose_project': r'[a-z0-9][a-z0-9_-]{0,62}',
        'desktop_service': r'[a-z0-9][a-z0-9_.-]{0,99}',
        'shared_desktop_room': r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',
    }
    if 'run_command_user' in value:
        patterns['run_command_user'] = patterns['deployment_user']
    for key, pattern in patterns.items():
        if not isinstance(value[key], str) or not re.fullmatch(pattern, value[key]):
            raise ValueError('Invalid deployment configuration: ' + key)
    for key in ['checkout_root', 'shared_storage_root']:
        path = value[key]
        if (not isinstance(path, str) or not re.fullmatch(r'/[A-Za-z0-9_./-]+', path)
                or '..' in Path(path).parts or len(Path(path).parts) < 3
                or str(Path(path)) != path):
            raise ValueError('Invalid absolute deployment path: ' + key)
    if value['checkout_root'] == value['shared_storage_root']:
        raise ValueError('Checkout and shared storage must be separate')
    origin = urlsplit(value['public_origin']) if isinstance(value['public_origin'], str) else None
    if (not origin or origin.scheme != 'https' or not origin.hostname or origin.username
            or origin.password or origin.query or origin.fragment or origin.path not in ['', '/']):
        raise ValueError('An explicit HTTPS public origin is required')
    return dict(value, public_origin=value['public_origin'].rstrip('/'))


def read_root_file(path):
    # Neither a writable config nor a symlink may choose what the root command executes.
    for parent in path.parents:
        metadata = parent.stat()
        if metadata.st_uid != 0 or metadata.st_mode & 0o022:
            raise ValueError('Deployment configuration directory must be root-owned and not writable')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        metadata = os.fstat(fd)
        if metadata.st_uid != 0 or metadata.st_mode & 0o077 or not stat.S_ISREG(metadata.st_mode):
            raise ValueError('Deployment configuration must be root-owned with mode 0600')
        with os.fdopen(fd, 'rb', closefd=False) as source:
            data = source.read(1024 * 1024 + 1)
        if len(data) > 1024 * 1024:
            raise ValueError('Deployment configuration is too large')
        return data
    finally:
        os.close(fd)


def load_config():
    config = validate_config(json.loads(read_root_file(CONFIG_PATH)))
    read_root_file(COMPOSE_PATH)
    return config


def check_install_storage(config):
    home = Path(config['shared_storage_root']) / 'home'
    if home.is_symlink():
        raise ValueError('Shared desktop home must not be a symlink')
    if not os.path.ismount(home) and home.exists() and any(home.iterdir()):
        raise ValueError('Unmounted desktop home contains data; preserve and migrate it before installation')


def compose(config, *args):
    directory = Path(config['checkout_root']) / 'apps/community/deploy'
    return run('docker', 'compose', '--project-directory', str(directory),
               '--env-file', str(directory / '.env.production'),
               '-f', str(COMPOSE_PATH), '-p', config['compose_project'], *args, cwd=directory)

def run(*args, cwd=None, capture=False):
    return subprocess.run(args, cwd=cwd, check=True, text=True,
                          stdout=subprocess.PIPE if capture else None).stdout

def fetch(url):
    request = urllib.request.Request(url, headers={'User-Agent': 'CustomCloudBot-deploy'})
    return urllib.request.urlopen(request, timeout=60)

def validate_sha(value):
    if not re.fullmatch(r'[0-9a-f]{40}', value):
        raise ValueError('Expected a full lowercase Git commit SHA')
    return value

def extract(archive, destination):
    with tarfile.open(archive) as tar:
        members = tar.getmembers()
        for member in members:
            parts = Path(member.name).parts
            if (not parts or member.name.startswith('/') or '..' in parts
                    or not (member.isfile() or member.isdir())):
                raise ValueError('Unsafe source archive member')
        tar.extractall(destination, members=members)
    roots = list(destination.iterdir())
    if len(roots) != 1 or not roots[0].is_dir():
        raise ValueError('Expected one source tree')
    return roots[0]

def copy_source(source, destination):
    shutil.copytree(source, destination, dirs_exist_ok=True, ignore=shutil.ignore_patterns(
        '.env', '.env.*', '*.sqlite', '*.sqlite-*', 'private-integrations.json',
        'BUSINESS_CONTEXT.md', 'agent-context.md', '.openclaw-private'))


def desktop_digest(folder):
    digest = hashlib.sha256()
    for path in sorted(folder.rglob('*')):
        if path.is_file():
            digest.update(str(path.relative_to(folder)).encode())
            digest.update(path.read_bytes())
    return digest.hexdigest()

def update_env(path, values):
    lines = path.read_text().splitlines()
    lines = [line for line in lines if line.split('=', 1)[0] not in values]
    lines += [key + '=' + value for key, value in values.items()]
    temporary = path.with_name(path.name + '.pending')
    temporary.write_text('\n'.join(lines) + '\n')
    temporary.chmod(0o600)
    os.replace(temporary, path)

def verify(release, config, desktop=True):
    last_error = None
    for _ in range(30):
        try:
            with fetch('http://127.0.0.1:8787/api/health') as response:
                health = json.load(response)
            if health.get('ok') and health.get('release') == release:
                break
        except Exception as error:
            last_error = error
        time.sleep(2)
    else:
        raise RuntimeError('Release health did not match expected SHA') from last_error
    if desktop:
        # Actual RFB handshake through the app network, for each independent view.
        script = """
        import WebSocket from 'ws';
        for (const port of [6080,6081,6082]) {
          await new Promise((resolve,reject)=>{
            const ws=new WebSocket('ws://DESKTOP_SERVICE:'+port+'/websockify');
            const timer=setTimeout(()=>{ws.terminate();reject(Error('RFB timeout '+port));},10000);
            ws.on('error',e=>{clearTimeout(timer);reject(e);});
            ws.once('message',data=>{clearTimeout(timer);ws.close();
              if(!data.toString().startsWith('RFB '))reject(Error('Bad RFB '+port));else resolve();});
          });
          console.log('RFB view ready:',port);
        }
        """.replace('DESKTOP_SERVICE', config['desktop_service'])
        run('docker','exec',config['compose_project']+'-app-1','node','--input-type=module','-e',script)
        run('docker','exec',config['compose_project']+'-'+config['desktop_service']+'-1','google-chrome','--version')
        # Read-only device check: never capture the operator's mic or inject a
        # test tone into live apps. Signal routing is verified in isolated CI.
        media = """
        const response=await fetch('http://DESKTOP_SERVICE:6084/status',{signal:AbortSignal.timeout(5000)});
        const state=await response.json();
        if(!response.ok||!state.ok||state.microphone?.available!==true)throw Error('Virtual microphone unavailable');
        console.log('Desktop microphone runtime ready; camera transport:',state.camera?.supported===true?'ready':'unavailable');
        """.replace('DESKTOP_SERVICE', config['desktop_service'])
        run('docker','exec',config['compose_project']+'-app-1','node','--input-type=module','-e',media)

def deploy(sha):
    sha = validate_sha(sha)
    config = load_config()
    repo = config['repository']
    root = Path(config['checkout_root'])
    deployment = root / 'apps/community/deploy'
    storage = Path(config['shared_storage_root'])
    desktop = config['desktop_service']
    desktop_container = config['compose_project'] + '-' + desktop + '-1'
    app_image = config['compose_project'] + '-app'
    desktop_image = config['compose_project'] + '-desktop'
    settings = dict(line.split('=', 1) for line in (deployment / '.env.production').read_text().splitlines() if '=' in line and not line.startswith('#'))
    if settings.get('COMMUNITY_ORIGIN', '').rstrip('/') != config['public_origin']:
        raise ValueError('Private deployment origin does not match the application configuration')
    with fetch('https://api.github.com/repos/' + repo + '/commits/main') as response:
        main_sha = json.load(response)['sha']
    if sha != main_sha:
        raise ValueError('Refusing to deploy a commit that is no longer main')
    if not os.path.ismount(storage / 'home'):
        raise RuntimeError('Shared desktop storage is not mounted')
    if shutil.disk_usage(root).free < 1536 * 1024**2:
        raise RuntimeError('At least 1.5 GiB free disk is required before building')
    with tempfile.TemporaryDirectory(prefix='openclaw-release-', dir=root.parent) as folder:
        folder = Path(folder)
        archive = folder / 'source.tar.gz'
        with fetch('https://codeload.github.com/' + repo + '/tar.gz/' + sha) as response:
            with archive.open('wb') as output:
                shutil.copyfileobj(response, output)
        source_dir = folder / 'source'
        source_dir.mkdir()
        source = extract(archive, source_dir)
        new_desktop_hash = desktop_digest(source / 'apps/community/deploy/desktop')
        state = storage / 'deployed-desktop-hash'
        desktop_changed = not state.exists() or state.read_text().strip() != new_desktop_hash
        app_tag = app_image + ':' + sha
        desktop_tag = desktop_image + ':' + sha
        run('docker','build','--build-arg','RELEASE='+sha,'-t',app_tag,
            '-f',str(source/'apps/community/deploy/Dockerfile'),str(source))
        if desktop_changed:
            run('docker','build','-t',desktop_tag,'-f',
                str(source/'apps/community/deploy/desktop/Dockerfile.managed'),
                str(source/'apps/community/deploy/desktop'))
        old_app = run('docker','inspect',config['compose_project']+'-app-1','--format','{{.Image}}',capture=True).strip()
        old_desktop = run('docker','inspect',desktop_container,'--format','{{.Image}}',capture=True).strip()
        run('docker','tag',old_app,app_image + ':previous')
        run('docker','tag',old_desktop,desktop_image + ':previous')
        previous_release = json.loads(run('docker','exec',config['compose_project']+'-app-1','node','-e',
            "console.log(JSON.stringify(process.env.COMMUNITY_RELEASE))",capture=True))
        # SQLite backup API includes WAL state; never copy a live database file.
        backup_js = """
        const { DatabaseSync, backup }=await import('node:sqlite');
        const fs=await import('node:fs');fs.mkdirSync('/data/deploy-backups',{recursive:true,mode:0o700});
        const db=new DatabaseSync('/data/community.sqlite');
        await backup(db,'/data/deploy-backups/before-SHA.sqlite');db.close();
        """.replace('SHA', sha)
        run('docker','exec',config['compose_project']+'-app-1','node','--input-type=module','-e',backup_js)
        old_compose = read_root_file(COMPOSE_PATH)
        old_env = (deployment/'.env.production').read_bytes()
        try:
            copy_source(source, root)
            update_env(deployment/'.env.production', {
                'COMMUNITY_SHARED_DESKTOP_ROOM':config['shared_desktop_room'],
                'COMMUNITY_DESKTOP_VIEWS':'1',
            })
            run('docker','tag',app_tag,app_image + ':local')
            if desktop_changed:
                run('docker','tag',desktop_tag,desktop_image + ':local')
                run('docker','tag',desktop_tag,desktop_image + ':managed')
                mounts = json.loads(run('docker','inspect',desktop_container,capture=True))[0]['Mounts']
                if not any(m['Destination']=='/home/desktop' for m in mounts):
                    run('docker','pause',desktop_container)
                    try:
                        # docker cp can expose the underlying image instead of a
                        # tmpfs. Read the paused process's actual mount namespace.
                        pid=run('docker','inspect',desktop_container,'--format','{{.State.Pid}}',capture=True).strip()
                        if not pid.isdigit() or int(pid)<1:
                            raise RuntimeError('Cannot locate paused desktop namespace')
                        run('cp','-a','/proc/'+pid+'/root/home/desktop/.',str(storage / 'home') + '/')
                    finally:
                        run('docker','unpause',desktop_container)
                run('chown','-hR','-P','10001:10001',str(storage / 'home'))
                run('docker','stop','--time','20',desktop_container)
                # Chrome's hostname lock cannot survive replacement of its container.
                for name in ['SingletonLock','SingletonSocket','SingletonCookie']:
                    path=(storage / 'home/chromium')/name
                    if path.is_symlink() or path.is_file():
                        path.unlink()
                compose(config,'up','-d','--no-deps','--no-build',desktop)
            compose(config,'up','-d','--no-deps','--no-build','--wait','--wait-timeout','120','app')
            verify(sha, config)
        except BaseException:
            print('Deployment failed; restoring previous app and desktop images.',flush=True)
            subprocess.run(['docker','logs','--tail','25',desktop_container])
            subprocess.run(['docker','inspect',desktop_container,'--format','{{json .State}}'])
            # The operator manifest stays outside the source tree and is never replaced.
            if read_root_file(COMPOSE_PATH) != old_compose:
                raise RuntimeError('Operator compose configuration changed during release')
            (deployment/'.env.production').write_bytes(old_env)
            (deployment/'.env.production').chmod(0o600)
            run('docker','tag',old_app,app_image + ':local')
            run('docker','tag',old_desktop,desktop_image + ':local')
            services = [desktop,'app'] if desktop_changed else ['app']
            compose(config,'up','-d','--no-deps','--no-build','--wait',*services)
            verify(previous_release,config,desktop=False)
            raise
        state.write_text(new_desktop_hash+'\n')
        (storage / 'deployed-release').write_text(sha+'\n')
        # Only retire this deployer's immutable tags; preserve current/previous
        # images, operator backup tags, other projects and every running image.
        for line in run('docker','image','ls','--format','{{.Repository}} {{.Tag}}',capture=True).splitlines():
            repository, tag = line.split()
            if (repository in [app_image,desktop_image]
                    and re.fullmatch(r'[0-9a-f]{40}',tag)
                    and tag not in [sha,previous_release]):
                subprocess.run(['docker','image','rm',repository+':'+tag],
                               stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        print('DEPLOYED '+sha,flush=True)

if __name__ == '__main__':
    os.umask(0o077)
    if len(sys.argv)!=2:
        sys.exit('Usage: openclaw-release <full-main-commit-sha>')
    validate_sha(sys.argv[1])
    if os.geteuid()!=0:
        sys.exit('Deployment command must be installed and run via sudo')
    with open('/run/lock/openclaw-deploy.lock','w') as lock:
        fcntl.flock(lock,fcntl.LOCK_EX)
        deploy(sys.argv[1])
