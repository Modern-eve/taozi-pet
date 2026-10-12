#!/usr/bin/env python3
"""按依赖要求定位解释器：环境位置变动时自动跟随。

流水线各脚本对解释器的要求不同——GPU 抠图脚本（preprocess-v7-gpu.py /
make-graphics.py）需要 torch + CUDA，其余脚本只需要 PIL / numpy。脚本在 main()
开头调用 ensure_env()：当前解释器已满足要求就直接运行，否则按环境名找到目标
解释器、用它重新执行当前脚本。因此不必预先 conda activate，conda 安装位置或
环境目录变动也无需改脚本与文档。

环境变量：
  TAOZI_PYTHON      直接指定解释器路径（优先级最高）
  TAOZI_CONDA_ENV   目标环境名，默认 my_project
  TAOZI_CONDA_ROOT  conda 安装根目录（逗号分隔多个），追加到扫描范围
  TAOZI_PY_ENV_DONE 重入哨兵，由本模块设置

自检：
  python python_env.py         # 打印目标环境的解析结果
"""
import importlib.util
import json
import os
import shutil
import subprocess
import sys

DEFAULT_CONDA_ENV = 'my_project'
SENTINEL = 'TAOZI_PY_ENV_DONE'

# path 中可执行文件所在层，去掉它即环境根目录（Windows 解释器直接位于根目录）
_BIN_DIRS = ('bin', 'scripts', 'condabin')

# 无 conda 可执行文件时扫描的环境根目录名称
_ENV_ROOT_NAMES = ('anaconda3', 'miniconda3', 'miniforge3', 'mambaforge')


def ensure_env(script_path, requires=('torch',)):
    """确保当前解释器装有 requires，不满足时切换解释器重跑 script_path。

    script_path 传 __file__，切换后原样透传本次命令行参数；子进程退出码即本进程
    退出码。requires 为必须可导入的模块名。
    """
    missing = [name for name in requires if not _importable(name)]
    if not missing:
        return

    env_name = os.environ.get('TAOZI_CONDA_ENV') or DEFAULT_CONDA_ENV
    searched = []
    target = None

    override = os.environ.get('TAOZI_PYTHON')
    if override:
        searched.append(f'TAOZI_PYTHON：{override}')
        if _has_all(override, requires):
            target = override

    if target is None:
        envs = _conda_env_map()
        if not envs:
            searched.append('conda env list：不可用')
        elif env_name in envs:
            env_path = envs[env_name]
            searched.append(f'conda env list：{env_name} → {env_path}')
            candidate = _python_of(env_path)
            if _has_all(candidate, requires):
                target = candidate
            else:
                searched.append(f'  该环境未提供 {" / ".join(requires)}')
        else:
            searched.append(f'conda env list：无名为 {env_name} 的环境')

    if target is None:
        for env_dir in _env_dirs():
            candidate = _python_of(os.path.join(env_dir, env_name))
            if not candidate:
                continue
            searched.append(f'扫描目录：{candidate}')
            if _has_all(candidate, requires):
                target = candidate
                break

    if target is None:
        _fail(missing, requires, searched, env_name)

    if _same_file(target, sys.executable):
        searched.append(f'解析结果与当前解释器相同：{target}')
        _fail(missing, requires, searched, env_name)

    child_env = dict(os.environ)
    child_env[SENTINEL] = '1'
    print(f'[env] 当前解释器缺少 {" / ".join(missing)}，改用 {target}')
    sys.stdout.flush()
    completed = subprocess.run(
        [target, os.path.abspath(script_path), *sys.argv[1:]],
        env=child_env,
    )
    raise SystemExit(completed.returncode)


def _fail(missing, requires, searched, env_name):
    if os.environ.get(SENTINEL):
        head = '[env] 已切换到目标解释器，但仍缺少依赖，停止以避免反复重入：'
    else:
        head = f'[env] 本脚本需要 {" / ".join(requires)}，当前解释器缺少 {" / ".join(missing)}。'
    lines = [
        head,
        f'[env]   {sys.executable}',
        f'[env] 未找到可用的环境「{env_name}」。已检查：',
    ]
    lines.extend(f'[env]   - {item}' for item in searched)
    lines.extend([
        '[env] 处理方式（任选其一）：',
        '[env]   - 指定解释器：TAOZI_PYTHON=<python.exe 路径>',
        f'[env]   - 指定环境名：TAOZI_CONDA_ENV=<环境名>（默认 {DEFAULT_CONDA_ENV}）',
        '[env]   - conda 装在非常规位置：TAOZI_CONDA_ROOT=<conda 安装根目录>',
        f'[env]   - 或在已 activate {env_name} 的终端里运行',
    ])
    print('\n'.join(lines), file=sys.stderr)
    raise SystemExit(1)


def _importable(name):
    try:
        return importlib.util.find_spec(name) is not None
    except (ImportError, ValueError):
        return False


def _has_all(python, requires):
    """目标解释器是否装有全部 requires（查其 site-packages，不启动进程）。"""
    if not python or not os.path.isfile(python):
        return False
    if _same_file(python, sys.executable):
        return all(_importable(name) for name in requires)
    site_dirs = _site_packages(python)
    for name in requires:
        found = False
        for site_dir in site_dirs:
            if os.path.isdir(os.path.join(site_dir, name)) or \
                    os.path.isfile(os.path.join(site_dir, name + '.py')):
                found = True
                break
        if not found:
            return False
    return True


def _same_file(left, right):
    try:
        return os.path.normcase(os.path.abspath(left)) == \
            os.path.normcase(os.path.abspath(right))
    except (OSError, TypeError):
        return False


def _site_packages(python):
    """目标解释器的 site-packages 候选目录（Windows 与 POSIX 布局各一条）。"""
    root = _env_root(python)
    dirs = []
    windows_dir = os.path.join(root, 'Lib', 'site-packages')
    if os.path.isdir(windows_dir):
        dirs.append(windows_dir)
    lib_dir = os.path.join(root, 'lib')
    if os.path.isdir(lib_dir):
        for entry in sorted(os.listdir(lib_dir)):
            candidate = os.path.join(lib_dir, entry, 'site-packages')
            if os.path.isdir(candidate):
                dirs.append(candidate)
    return dirs


def _env_root(python):
    parent = os.path.dirname(os.path.abspath(python))
    if os.path.basename(parent).lower() in _BIN_DIRS:
        return os.path.dirname(parent)
    return parent


def _python_of(env_path):
    if not env_path:
        return None
    for rel in ('python.exe', os.path.join('bin', 'python'), os.path.join('bin', 'python3')):
        candidate = os.path.join(env_path, rel)
        if os.path.isfile(candidate):
            return candidate
    return None


def _conda_executable():
    for key in ('CONDA_EXE', 'CONDA_BAT'):
        value = os.environ.get(key)
        if value and os.path.isfile(value):
            return value
    for name in ('conda.exe', 'conda.cmd', 'conda.bat', 'conda'):
        found = shutil.which(name)
        if found:
            return found
    return None


def _conda_json(args):
    executable = _conda_executable()
    if not executable:
        return None
    command = [executable, *args]
    if executable.lower().endswith(('.bat', '.cmd')):
        command = [os.environ.get('COMSPEC') or 'cmd.exe', '/c', *command]
    try:
        completed = subprocess.run(command, capture_output=True, text=True, timeout=90)
    except (OSError, subprocess.SubprocessError):
        return None
    text = completed.stdout or ''
    start = text.find('{')
    if start < 0:
        return None
    try:
        return json.loads(text[start:])
    except ValueError:
        return None


def _conda_env_map():
    """环境名 → 环境目录。取 conda env list 的权威结果。"""
    data = _conda_json(['env', 'list', '--json'])
    if not isinstance(data, dict):
        return {}
    mapping = {}
    for path in data.get('envs') or []:
        name = os.path.basename(str(path).rstrip('\\/'))
        if name and name not in mapping:
            mapping[name] = path
    return mapping


def _env_dirs():
    """conda 环境目录候选：安装根下的 envs/，以及 .condarc 的 envs_dirs。"""
    roots = []
    for key in ('CONDA_ROOT', 'CONDA_PREFIX_1', 'CONDA_PREFIX'):
        value = os.environ.get(key)
        if value:
            roots.append(value)
    executable = _conda_executable()
    if executable:
        parent = os.path.dirname(os.path.abspath(executable))
        roots.append(os.path.dirname(parent)
                     if os.path.basename(parent).lower() in _BIN_DIRS else parent)
    home = os.path.expanduser('~')
    roots.extend(os.path.join(home, name) for name in _ENV_ROOT_NAMES)
    local_app_data = os.environ.get('LOCALAPPDATA')
    if local_app_data:
        roots.extend(os.path.join(local_app_data, name) for name in _ENV_ROOT_NAMES)
    program_data = os.environ.get('ProgramData')
    if program_data:
        roots.extend(os.path.join(program_data, name) for name in _ENV_ROOT_NAMES)
    roots.extend(entry.strip()
                 for entry in (os.environ.get('TAOZI_CONDA_ROOT') or '').split(',')
                 if entry.strip())

    dirs = list(_condarc_envs_dirs())
    dirs.extend(os.path.join(root, 'envs') for root in roots)

    unique, seen = [], set()
    for path in dirs:
        key = os.path.normcase(os.path.abspath(path))
        if key not in seen:
            seen.add(key)
            unique.append(path)
    return unique


def _condarc_envs_dirs():
    """从 .condarc 读 envs_dirs（支持缩进列表与行内方括号两种写法）。"""
    candidates = [os.environ.get('CONDARC'), os.path.join(os.path.expanduser('~'), '.condarc')]
    for path in candidates:
        if not path or not os.path.isfile(path):
            continue
        try:
            with open(path, 'r', encoding='utf-8') as handle:
                lines = handle.read().splitlines()
        except OSError:
            continue
        dirs, in_block = [], False
        for line in lines:
            stripped = line.strip()
            if not in_block:
                if stripped.startswith('envs_dirs:'):
                    inline = stripped[len('envs_dirs:'):].strip()
                    if inline.startswith('['):
                        dirs.extend(part.strip().strip('\'"')
                                    for part in inline.strip('[]').split(',')
                                    if part.strip())
                    else:
                        in_block = True
                continue
            if stripped.startswith('- '):
                dirs.append(stripped[2:].strip().strip('\'"'))
            elif stripped and not line[:1].isspace():
                in_block = False
        return dirs
    return []


def _describe():
    env_name = os.environ.get('TAOZI_CONDA_ENV') or DEFAULT_CONDA_ENV
    print(f'目标环境名：{env_name}')
    envs = _conda_env_map()
    if envs:
        for name, path in sorted(envs.items()):
            print(f'  conda env list：{name} → {path}')
    else:
        print('  conda env list：不可用')
    for env_dir in _env_dirs():
        print(f'  扫描目录：{env_dir}')
    for requires in (('torch',), ('PIL', 'numpy')):
        resolved = None
        for env_dir in _env_dirs():
            candidate = _python_of(os.path.join(env_dir, env_name))
            if _has_all(candidate, requires):
                resolved = candidate
                break
        if resolved is None and env_name in envs:
            candidate = _python_of(envs[env_name])
            if _has_all(candidate, requires):
                resolved = candidate
        label = ' + '.join(requires)
        print(f'  {label}：{resolved or "未找到"}')


if __name__ == '__main__':
    _describe()
