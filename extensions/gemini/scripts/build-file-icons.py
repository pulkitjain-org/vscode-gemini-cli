#!/usr/bin/env python3
# ---------------------------------------------------------------------------------------------
#  Copyright (c) pulkitjain-org and contributors. All rights reserved.
#  Licensed under the MIT License. See License.txt in the project root for license information.
# ---------------------------------------------------------------------------------------------

# Draws the GeminiCode file icon theme: a tinted tile with a short label per
# language, plus a few drawn icons (folders, images, archives). Labels are
# turned into outlines with the bundled JetBrains Mono, so the icons look the
# same on every Mac. Needs fontTools (pip install fonttools). Run after a change:
#
#   python3 extensions/gemini/scripts/build-file-icons.py

import json
import os
import shutil

from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO = os.path.dirname(os.path.dirname(ROOT))
FONT = os.path.join(REPO, 'src/vs/workbench/contrib/gemini/electron-browser/media/jetbrains-mono-latin-normal.ttf')
OUT = os.path.join(ROOT, 'icons')

# id, label, colour on dark, colour on light, file extensions, file names
LABELS = [
	('typescript', 'TS', '#4D9BF0', '#2F6FC4', ['ts', 'mts', 'cts'], []),
	('typescript-def', 'DT', '#4D9BF0', '#2F6FC4', ['d.ts', 'd.mts', 'd.cts'], []),
	('javascript', 'JS', '#F2D64B', '#9A7B00', ['js', 'mjs', 'cjs'], []),
	('react', 'RX', '#61DAFB', '#0A7EA4', ['jsx', 'tsx'], []),
	('json', '{}', '#81C995', '#1E8E3E', ['json', 'jsonc', 'json5', 'jsonl'], []),
	('npm', 'NP', '#F28B82', '#C5221F', [], ['package.json', 'package-lock.json', '.npmrc', '.nvmrc']),
	('tsconfig', 'TC', '#4D9BF0', '#2F6FC4', [], ['tsconfig.json', 'jsconfig.json']),
	('html', '<>', '#F28B6B', '#C2410C', ['html', 'htm'], []),
	('css', '#', '#64B5F6', '#1565C0', ['css'], []),
	('sass', 'SC', '#F48FB1', '#AD1457', ['scss', 'sass'], []),
	('less', 'LS', '#8EA6E8', '#3949AB', ['less'], []),
	('markdown', 'MD', '#B69CF6', '#7A3EC8', ['md', 'mdx', 'markdown'], []),
	('readme', 'i', '#8AB4F8', '#1A5FD6', [], ['README.md', 'readme.md', 'README']),
	('gemini', 'G', '#A79CF2', '#6750C9', [], ['GEMINI.md', 'gemini.md']),
	('python', 'PY', '#F2CC60', '#8A6A00', ['py', 'pyi', 'pyw'], ['requirements.txt', 'pyproject.toml']),
	('go', 'GO', '#4DD0E1', '#00838F', ['go'], ['go.mod', 'go.sum']),
	('rust', 'RS', '#E3A982', '#A0522D', ['rs'], ['Cargo.toml', 'Cargo.lock']),
	('java', 'JV', '#F2A65A', '#B35900', ['java', 'jar', 'class'], []),
	('kotlin', 'KT', '#B39DFF', '#6D4AFF', ['kt', 'kts'], []),
	('gradle', 'GR', '#7FC4D9', '#2E7D99', ['gradle'], ['gradlew', 'build.gradle', 'settings.gradle']),
	('scala', 'SC', '#F28B82', '#C62828', ['scala', 'sc'], []),
	('c', 'C', '#A8B9CC', '#4F6276', ['c', 'h'], []),
	('cpp', 'C+', '#7EA7DB', '#2C5C9A', ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx'], []),
	('csharp', 'C#', '#C39BE0', '#7B3FA6', ['cs', 'csx'], []),
	('swift', 'SW', '#F7896B', '#D0461F', ['swift'], ['Package.swift']),
	('objc', 'OC', '#7AAEFF', '#2A6BD1', ['m', 'mm'], []),
	('ruby', 'RB', '#F28B82', '#B3261E', ['rb', 'erb', 'rake'], ['Gemfile', 'Gemfile.lock', 'Rakefile']),
	('php', 'PH', '#A3A7E0', '#575CA8', ['php'], []),
	('lua', 'LU', '#8C9EFF', '#3949AB', ['lua'], []),
	('r', 'R', '#7AB3E8', '#1F5FA8', ['r', 'rmd'], []),
	('dart', 'DA', '#5CC8F5', '#0277BD', ['dart'], ['pubspec.yaml']),
	('elixir', 'EX', '#B794E8', '#6A3FB5', ['ex', 'exs', 'heex'], []),
	('haskell', 'HS', '#B3A1E8', '#5E4AA8', ['hs', 'lhs'], []),
	('zig', 'ZG', '#F7B955', '#A86A00', ['zig'], []),
	('vue', 'V', '#6CCB9F', '#2E8B57', ['vue'], []),
	('svelte', 'SV', '#FF8A65', '#D84315', ['svelte'], []),
	('astro', 'AS', '#FF9C6E', '#D9480F', ['astro'], []),
	('shell', '$', '#9BE08A', '#2E7D32', ['sh', 'bash', 'zsh', 'fish', 'command'], ['.zshrc', '.bashrc', '.bash_profile', '.profile']),
	('powershell', 'PS', '#7AA7FF', '#2858B8', ['ps1', 'psm1', 'psd1'], []),
	('yaml', 'YM', '#F2A0A8', '#B3283A', ['yaml', 'yml'], []),
	('toml', 'TM', '#D9A07E', '#8D4E25', ['toml'], []),
	('config', 'CF', '#9AA0AA', '#5F6672', ['ini', 'cfg', 'conf', 'properties', 'plist'], ['.editorconfig']),
	('env', 'EV', '#F2D64B', '#8A6A00', ['env'], ['.env', '.env.local', '.env.example', '.env.development', '.env.production', '.envrc']),
	('xml', 'XM', '#F2A65A', '#B35900', ['xml', 'xsd', 'xsl', 'xaml'], []),
	('sql', 'SQ', '#F2B862', '#A65E00', ['sql', 'psql', 'mysql'], []),
	('database', 'DB', '#B0BEC5', '#546E7A', ['db', 'sqlite', 'sqlite3'], []),
	('graphql', 'GQ', '#F48FCC', '#B5179E', ['graphql', 'gql'], []),
	('proto', 'PB', '#8AB4F8', '#1A5FD6', ['proto'], []),
	('docker', 'DK', '#5AB4F5', '#1569B8', ['dockerfile'], ['Dockerfile', 'dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml', '.dockerignore']),
	('make', 'MK', '#A3B1BA', '#546E7A', ['mk', 'mak'], ['Makefile', 'makefile', 'GNUmakefile', 'CMakeLists.txt']),
	('git', 'GI', '#F4846A', '#C93C1E', [], ['.gitignore', '.gitattributes', '.gitmodules', '.gitkeep', '.mailmap']),
	('license', 'LI', '#F2C17D', '#A35A00', [], ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'License.txt', 'LICENCE', 'COPYING']),
	('text', 'TX', '#9AA0AA', '#5F6672', ['txt', 'text', 'rst'], []),
	('log', 'LG', '#9AA0AA', '#5F6672', ['log'], []),
	('csv', 'CV', '#81C995', '#1E8E3E', ['csv', 'tsv', 'xlsx', 'xls'], []),
	('notebook', 'NB', '#F7A35C', '#C25E00', ['ipynb'], []),
	('eslint', 'ES', '#A3A0F7', '#4B47C9', [], ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.json', '.eslintrc.cjs', '.eslintignore']),
	('prettier', 'PR', '#F7C55C', '#A87400', [], ['.prettierrc', '.prettierrc.json', '.prettierrc.js', 'prettier.config.js', '.prettierignore']),
	('vite', 'VI', '#B69CF6', '#7A3EC8', [], ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vitest.config.ts', 'vitest.config.mts', 'vitest.config.js']),
	('font', 'Aa', '#FF8A65', '#D84315', ['ttf', 'otf', 'woff', 'woff2'], []),
	('wasm', 'WA', '#9C8CF6', '#5B47D6', ['wasm', 'wat'], []),
	('diff', '\u00b1', '#81C995', '#1E8E3E', ['diff', 'patch'], []),
	('terraform', 'TF', '#A88BEB', '#6236C4', ['tf', 'tfvars', 'hcl'], []),
	('pdf', 'PD', '#F28B82', '#C5221F', ['pdf'], []),
]

# Drawn icons: id, colour on dark, colour on light, shape, file extensions, file names
DRAWN = [
	('image', '#4DB6AC', '#00796B', 'image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'avif', 'heic', 'icns', 'svg'], []),
	('media', '#F48FB1', '#AD1457', 'play', ['mp3', 'mp4', 'wav', 'mov', 'webm', 'ogg', 'm4a', 'flac'], []),
	('archive', '#C5CC6B', '#7C8500', 'archive', ['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'dmg', 'vsix'], []),
	('lock', '#9AA0AA', '#5F6672', 'lock', ['lock'], ['yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'Podfile.lock', 'composer.lock']),
]

# Folders: id, colour on dark, colour on light, folder names
FOLDERS = [
	('folder', '#8B909A', '#7A808A', []),
	('folder-src', '#8AB4F8', '#1A5FD6', ['src', 'source', 'lib', 'app']),
	('folder-test', '#81C995', '#1E8E3E', ['test', 'tests', '__tests__', 'spec', 'e2e']),
	('folder-docs', '#F2C17D', '#A35A00', ['docs', 'doc']),
	('folder-github', '#B69CF6', '#7A3EC8', ['.github', '.gitlab']),
	('folder-gemini', '#A79CF2', '#6750C9', ['.gemini']),
	('folder-vscode', '#64B5F6', '#1565C0', ['.vscode']),
	('folder-dist', '#F28B82', '#C5221F', ['dist', 'out', 'build', 'target', '.next']),
	('folder-modules', '#5C616B', '#9AA0AA', ['node_modules', '.venv', 'venv', 'vendor', 'Pods']),
	('folder-assets', '#4DB6AC', '#00796B', ['assets', 'images', 'img', 'public', 'static', 'media', 'icons']),
	('folder-config', '#9AA0AA', '#5F6672', ['config', '.config', 'scripts', '.husky']),
]


def load_font():
	font = TTFont(FONT)
	return instancer.instantiateVariableFont(font, {'wght': 800})


def label_path(font, text, box):
	"""The outline of `text`, centred in a `box`-wide square tile, scaled to fit."""
	glyphs = font.getGlyphSet()
	cmap = font.getBestCmap()
	upm = font['head'].unitsPerEm
	advance = sum(glyphs[cmap[ord(ch)]].width for ch in text)
	cap = font['OS/2'].sCapHeight or 730
	# Two letters fill most of the tile; one letter or a symbol stays the same height.
	height = 6.4 if len(text) > 1 else 7.4
	scale = min(height / cap, (box - 4.6) / advance)
	width = advance * scale
	x = (16 - width) / 2
	baseline = 8 + cap * scale / 2
	pen = SVGPathPen(glyphs)
	for ch in text:
		name = cmap[ord(ch)]
		tpen = TransformPen(pen, (scale, 0, 0, -scale, x, baseline))
		glyphs[name].draw(tpen)
		x += glyphs[name].width * scale
	return pen.getCommands()


def rounded(cmds):
	import re
	return re.sub(r'-?\d+\.\d+', lambda m: ('%.2f' % float(m.group())).rstrip('0').rstrip('.'), cmds)


def svg(body):
	return f'<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16">{body}</svg>\n'


def tile(color):
	return f'<rect x="1" y="1" width="14" height="14" rx="3.5" fill="{color}" fill-opacity=".16"/>'


DRAWINGS = {
	'image': lambda c: tile(c) + f'<circle cx="5.6" cy="5.6" r="1.4" fill="{c}"/><path d="M3 12.2 6.4 8.4l2.2 2.3 1.6-1.6 2.8 3.1z" fill="{c}"/>',
	'play': lambda c: tile(c) + f'<path d="M6 4.6v6.8l5.6-3.4z" fill="{c}"/>',
	'archive': lambda c: tile(c) + f'<path d="M7 2h2v1.4H7zm0 2.4h2v1.4H7zm0 2.4h2v1.4H7z" fill="{c}"/><rect x="6.2" y="9" width="3.6" height="4" rx="1" fill="none" stroke="{c}" stroke-width="1.3"/>',
	'lock': lambda c: tile(c) + f'<rect x="4.5" y="7.2" width="7" height="5.3" rx="1.2" fill="{c}"/><path d="M5.9 7.2V5.6a2.1 2.1 0 0 1 4.2 0v1.6" fill="none" stroke="{c}" stroke-width="1.3"/>',
}


def folder(color, open_):
	if open_:
		return (f'<path d="M1.5 4.2c0-.9.7-1.6 1.6-1.6h3l1.5 1.5h4.8c.9 0 1.6.7 1.6 1.6v.6H4.2c-.7 0-1.3.4-1.5 1L1.5 11z" fill="{color}" fill-opacity=".55"/>'
				f'<path d="M2.6 7.1c.2-.6.8-1 1.5-1h10.4c.7 0 1.2.7 1 1.4l-1.4 4.8c-.2.6-.8 1.1-1.5 1.1H2.8c-.9 0-1.5-.8-1.2-1.6z" fill="{color}"/>')
	return (f'<path d="M1.5 4.2c0-.9.7-1.6 1.6-1.6h3l1.5 1.5h5.3c.9 0 1.6.7 1.6 1.6v6.6c0 .9-.7 1.6-1.6 1.6H3.1c-.9 0-1.6-.7-1.6-1.6z" fill="{color}" fill-opacity=".55"/>'
			f'<path d="M1.5 6.4c0-.6.5-1.1 1.1-1.1h10.8c.6 0 1.1.5 1.1 1.1v5.2c0 .9-.7 1.6-1.6 1.6H3.1c-.9 0-1.6-.7-1.6-1.6z" fill="{color}"/>')


def default_file(color):
	return f'<path d="M4 1.5h5l3.5 3.5v8.3c0 .7-.5 1.2-1.2 1.2H4.2c-.7 0-1.2-.5-1.2-1.2V2.7c0-.7.5-1.2 1-1.2z" fill="none" stroke="{color}" stroke-width="1.2" stroke-linejoin="round"/><path d="M9 1.7V5h3.3" fill="none" stroke="{color}" stroke-width="1.2" stroke-linejoin="round"/>'


def main():
	font = load_font()
	shutil.rmtree(OUT, ignore_errors=True)
	for variant in ('dark', 'light'):
		os.makedirs(os.path.join(OUT, variant))
	definitions = {}
	sections = {variant: {'fileExtensions': {}, 'fileNames': {}, 'folderNames': {}, 'folderNamesExpanded': {}} for variant in ('dark', 'light')}

	def write(icon_id, dark_body, light_body):
		for variant, body in (('dark', dark_body), ('light', light_body)):
			with open(os.path.join(OUT, variant, f'{icon_id}.svg'), 'w') as f:
				f.write(svg(body))
			key = icon_id if variant == 'dark' else f'{icon_id}_light'
			definitions[key] = {'iconPath': f'./{variant}/{icon_id}.svg'}

	def assign(variant, icon_id, extensions, names):
		key = icon_id if variant == 'dark' else f'{icon_id}_light'
		for ext in extensions:
			sections[variant]['fileExtensions'][ext] = key
		for name in names:
			sections[variant]['fileNames'][name] = key

	for icon_id, text, dark, light, extensions, names in LABELS:
		path = rounded(label_path(font, text, 16))
		write(icon_id, tile(dark) + f'<path d="{path}" fill="{dark}"/>', tile(light) + f'<path d="{path}" fill="{light}"/>')
		for variant in ('dark', 'light'):
			assign(variant, icon_id, extensions, names)
	for icon_id, dark, light, shape, extensions, names in DRAWN:
		write(icon_id, DRAWINGS[shape](dark), DRAWINGS[shape](light))
		for variant in ('dark', 'light'):
			assign(variant, icon_id, extensions, names)
	write('file', default_file('#8B909A'), default_file('#7A808A'))
	for icon_id, dark, light, names in FOLDERS:
		write(icon_id, folder(dark, False), folder(light, False))
		write(f'{icon_id}-open', folder(dark, True), folder(light, True))
		for variant in ('dark', 'light'):
			suffix = '' if variant == 'dark' else '_light'
			for name in names:
				sections[variant]['folderNames'][name] = icon_id + suffix
				sections[variant]['folderNamesExpanded'][name] = f'{icon_id}-open{suffix}'

	theme = {
		'iconDefinitions': definitions,
		'file': 'file',
		'folder': 'folder',
		'folderExpanded': 'folder-open',
		'rootFolder': 'folder',
		'rootFolderExpanded': 'folder-open',
		**sections['dark'],
		'light': {
			'file': 'file_light',
			'folder': 'folder_light',
			'folderExpanded': 'folder-open_light',
			'rootFolder': 'folder_light',
			'rootFolderExpanded': 'folder-open_light',
			**sections['light'],
		},
		'hidesExplorerArrows': False,
	}
	with open(os.path.join(OUT, 'geminicode-icon-theme.json'), 'w') as f:
		json.dump(theme, f, indent='\t')
		f.write('\n')
	print(f'Wrote {len(definitions) // 2} icons to {os.path.relpath(OUT, REPO)}')


if __name__ == '__main__':
	main()
