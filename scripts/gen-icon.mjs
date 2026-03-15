import { writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'

const __dir = dirname(fileURLToPath(import.meta.url))
const root  = join(__dir, '..')
const bld   = join(root, 'build')
const svg   = join(root, 'resources', 'icon.svg')
mkdirSync(bld, { recursive: true })

const sizes = [16, 32, 48, 64, 128, 256]
const bufs  = {}

console.log('🎨 Generating YouDownload icons...\n')

for (const s of sizes) {
  const out = join(bld, `icon-${s}.png`)
  execSync(`sharp -i "${svg}" -o "${out}" resize ${s} ${s}`, { stdio: 'inherit' })
  const { readFileSync } = await import('fs')
  bufs[s] = readFileSync(out)
  console.log(`  ✓ icon-${s}.png`)
}

// icon.png (256px) for Linux/macOS
writeFileSync(join(bld, 'icon.png'), bufs[256])
console.log('  ✓ build/icon.png')

// Assemble ICO for Windows
function buildIco(images) {
  const count = images.length
  let offset = 6 + 16 * count
  const entries = images.map(img => { const e = { ...img, offset }; offset += img.data.length; return e })
  const buf = Buffer.alloc(offset)
  let p = 0
  buf.writeUInt16LE(0, p); p += 2
  buf.writeUInt16LE(1, p); p += 2
  buf.writeUInt16LE(count, p); p += 2
  for (const e of entries) {
    buf.writeUInt8(e.size >= 256 ? 0 : e.size, p++); buf.writeUInt8(e.size >= 256 ? 0 : e.size, p++)
    buf.writeUInt8(0, p++); buf.writeUInt8(0, p++)
    buf.writeUInt16LE(1, p); p += 2
    buf.writeUInt16LE(32, p); p += 2
    buf.writeUInt32LE(e.data.length, p); p += 4
    buf.writeUInt32LE(e.offset, p); p += 4
  }
  for (const e of entries) e.data.copy(buf, e.offset)
  return buf
}

const ico = buildIco(sizes.map(s => ({ size: s, data: bufs[s] })))
writeFileSync(join(bld, 'icon.ico'), ico)
console.log('  ✓ build/icon.ico')
console.log('\n✅ Done!')
