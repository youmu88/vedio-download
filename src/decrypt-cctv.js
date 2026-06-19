/**
 * CCTV 视频 ts 分片解密模块
 *
 * 央视网（tv.cctv.com / v.cctv.cn）的 ts 视频分片使用自定义 XOR 加密。
 * 本模块实现 ts 分片的 NALU 级别条件解密，恢复可播放的视频流。
 *
 * ⭐ 解密原理（基于 scz.617.cn 文章分析）：
 *
 *   解密层次结构：
 *     TS Packet (188B) → PES (Packetized Elementary Stream) → NALUnit[]
 *
 *   关键算法：
 *     1. 按 188 字节遍历 TS 包，过滤 PID=0x1011 等视频流
 *     2. 将同属一个 PES 的多个 TS Packet payload 拼接成完整 PES
 *     3. **不对 PES 做 PES 解码**，直接在 PES 数据中搜索 NAL Unit 起始码 0x000001
 *     4. 使用 FindNalUnitStart() 高效搜索起始码
 *     5. **仅对 nal_unit_type ∈ {1, 5, 25} 的 NAL Unit 执行 XOR 解密**
 *     6. 将解密后的数据按原位置写回 TS 包
 *
 *   参考：
 *     - https://scz.617.cn/web/202408231518.txt
 *
 * @module decrypt-cctv
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

// ─── 常量 ───────────────────────────────────────────
const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;

// 已知的 CCTV 视频 TS 包 PID 列表
const VIDEO_PIDS = new Set([
  0x1011, // 常见视频 PID
  0x31,   // 备用视频 PID
  0x101,  // 其他常见视频 PID
]);

// 需要解密的 NAL Unit type
const DECRYPT_NALU_TYPES = new Set([1, 5, 25]);

// ─── 工具函数 ──────────────────────────────────────

/**
 * 从 m3u8 URL 中提取 contentId（标识字符串）
 * 格式：.../default/{contentId}/main.m3u8?...
 * @param {string} m3u8Url
 * @returns {string}
 */
export function extractContentId(m3u8Url) {
  // 匹配 default/ 和 / 之间的 32 位 hex 字符串
  const match = m3u8Url.match(/default\/([a-f0-9]{32})\//i);
  if (match) return match[1];

  // 备用：匹配 URL 路径中的 hash 段
  const altMatch = m3u8Url.match(/\/([a-f0-9]{32})\//);
  if (altMatch) return altMatch[1];

  // 兜底：用 URL 整体 MD5
  return crypto.createHash('md5').update(m3u8Url).digest('hex');
}

/**
 * 从 contentId 派生 16 字节解密密钥
 * 算法：contentId 的 MD5 值
 * @param {string} contentId
 * @returns {Buffer}
 */
function deriveKey(contentId) {
  return crypto.createHash('md5').update(contentId).digest();
}

// ─── NALU 解析 ─────────────────────────────────────

/**
 * 在字节流中搜索 NAL Unit 起始码 0x000001
 *
 * 这是 H.264/HEVC 的标准 NALU 起始码搜索算法。
 * 搜索模式：连续字节 [0x00, 0x00, 0x01] 标记 NALU 起始。
 *
 * @param {Buffer} data - 字节流数据
 * @param {number} startOffset - 搜索起始偏移量
 * @returns {number} 找到的 NALU 起始位置，未找到则返回 -1
 */
function findNalUnitStart(data, startOffset) {
  // 需要至少 3 字节来匹配 0x000001
  if (startOffset + 3 > data.length) return -1;

  // 从 startOffset 开始搜索 0x000001
  // 使用字节级搜索，避免 JS 字符串转换问题
  for (let i = startOffset; i <= data.length - 3; i++) {
    if (data[i] === 0x00 && data[i + 1] === 0x00 && data[i + 2] === 0x01) {
      return i;
    }
  }

  return -1;
}

/**
 * 获取 NAL Unit 的类型
 * NALU 的第一个字节：+------+ |0|1|2|3|4|5|6|7| +------+ |F|NRI| Type  | +------+
 * nal_unit_type = firstByte & 0x1F
 *
 * @param {Buffer} data - 包含 NALU 的字节流
 * @param {number} naluStart - NALU 起始位置（0x000001 的 0x01 所在位置）
 * @returns {number} nal_unit_type
 */
function getNalUnitType(data, naluStart) {
  // NALU 起始码为 0x00 0x00 0x01，类型字节在起始码之后
  // naluStart 指向 0x01 的位置，类型字节在 naluStart + 1
  const typeBytePos = naluStart + 1;
  if (typeBytePos >= data.length) return -1;
  return data[typeBytePos] & 0x1f;
}

// ─── PES 拼接与 NALU 遍历解密 ──────────────────────

/**
 * 解析 TS 包头部，提取关键字段
 *
 * @param {Buffer} tsPacket - 188 字节的 TS 包
 * @param {number} offset - TS 包在完整 tsData 中的偏移量
 * @returns {{ pid: number, afc: number, hasPayload: boolean, payloadStart: number, pusi: boolean }}
 */
function parseTsHeader(tsPacket, offset) {
  const pid = ((tsPacket[1] & 0x1f) << 8) | tsPacket[2];
  const afc = (tsPacket[3] >> 4) & 0x03;
  const pusi = (tsPacket[1] >> 6) & 0x01;

  // 计算 payload 起始位置
  let payloadStart = 4; // 相对 TS 包起始的偏移
  if (afc === 2 || afc === 3) {
    const afLength = tsPacket[payloadStart];
    payloadStart += 1 + afLength;
  }

  const hasPayload = (afc === 1 || afc === 3);

  return {
    pid,
    afc,
    hasPayload,
    payloadStart: offset + payloadStart, // 在完整 tsData 中的绝对偏移
    pusi: pusi === 1,
  };
}

/**
 * 将多个 TS packet 的 payload 拼接为 PES 数据，同时记录每个字节对应的 TS 包位置
 *
 * @param {Buffer} tsData - 完整 ts 文件数据
 * @param {number} tsPacketIndex - 当前 TS 包在 tsData 中的偏移
 * @returns {{ pesData: Buffer, byteToTsMap: Array<{packetOffset: number, payloadOffset: number}> }}
 *   返回拼接的 PES 数据和字节到 TS 包位置的映射
 */
function buildPesFromTsPackets(tsData, tsPacketIndex, key) {
  const segments = []; // [{payloadStart: number, payloadEnd: number, packetOffset: number}]
  let totalPayloadLen = 0;

  let i = tsPacketIndex;
  while (i + TS_PACKET_SIZE <= tsData.length) {
    if (tsData[i] !== TS_SYNC_BYTE) break;

    const hdr = parseTsHeader(tsData.subarray(i, i + TS_PACKET_SIZE), i);
    if (hdr.pid === 0x1fff) break; // null packet, end of PES

    if (!hdr.hasPayload) {
      i += TS_PACKET_SIZE;
      continue;
    }

    const payloadEnd = i + TS_PACKET_SIZE;
    const payloadLen = payloadEnd - hdr.payloadStart;

    segments.push({
      payloadStart: hdr.payloadStart,
      payloadEnd,
      packetOffset: i,
    });
    totalPayloadLen += payloadLen;

    // 检查下一个 TS 包的 PUSI 标志——如果 PUSI=1，说明是新的 PES 起始，停止拼接
    const nextPacketOffset = i + TS_PACKET_SIZE;
    if (nextPacketOffset + TS_PACKET_SIZE <= tsData.length) {
      const nextPacket = tsData.subarray(nextPacketOffset, nextPacketOffset + TS_PACKET_SIZE);
      if (nextPacket[0] === TS_SYNC_BYTE) {
        const nextPusi = (nextPacket[1] >> 6) & 0x01;
        // 如果下一个包是视频 PID 且 PUSI=1，说明是新 PES 开始
        const nextPid = ((nextPacket[1] & 0x1f) << 8) | nextPacket[2];
        if (nextPusi === 1 && VIDEO_PIDS.has(nextPid)) {
          i += TS_PACKET_SIZE;
          break;
        }
      }
    }

    i += TS_PACKET_SIZE;
  }

  // 拼接 PES 数据
  const pesData = Buffer.alloc(totalPayloadLen);
  const byteToTsMap = []; // 每个字节对应的 {packetOffset, payloadOffset}

  let writeOffset = 0;
  for (const seg of segments) {
    const len = seg.payloadEnd - seg.payloadStart;
    tsData.copy(pesData, writeOffset, seg.payloadStart, seg.payloadEnd);
    for (let j = 0; j < len; j++) {
      byteToTsMap.push({
        packetOffset: seg.packetOffset,
        payloadOffset: seg.payloadStart + j,
      });
    }
    writeOffset += len;
  }

  return { pesData, byteToTsMap };
}

/**
 * 对 PES 数据中的 NAL Unit 执行条件解密
 *
 * 算法（scz 文章）：
 *   1. 不对 PES 做 PES 解码
 *   2. 在 PES 数据中搜索 NAL Unit 起始码 0x000001
 *   3. 仅对 nal_unit_type ∈ {1, 5, 25} 的 NAL Unit 解密
 *
 * @param {Buffer} pesData - 拼接的 PES 数据
 * @param {Buffer} key - 16 字节 XOR 密钥
 * @param {Array} byteToTsMap - 字节到 TS 包位置的映射
 * @param {Buffer} output - 输出 buffer（ts 数据）
 */
function decryptNalusInPes(pesData, key, byteToTsMap, output) {
  let searchOffset = 0;
  let naluCount = 0;
  let decryptedCount = 0;

  while (true) {
    const naluStart = findNalUnitStart(pesData, searchOffset);
    if (naluStart === -1) break;

    const nalType = getNalUnitType(pesData, naluStart);
    if (nalType === -1) break;

    naluCount++;

    // 查找下一个 NALU 起始位置（或数据结尾）来确定当前 NALU 的范围
    const nextNaluStart = findNalUnitStart(pesData, naluStart + 3);
    const naluEnd = nextNaluStart !== -1 ? nextNaluStart : pesData.length;

    // NALU 数据范围（起始码之后的数据）：从 naluStart+3 到 naluEnd
    // 需要解密的是 NALU payload 部分，即起始码之后的所有字节
    const decryptStart = naluStart + 3; // 跳过 0x000001 起始码
    const decryptEnd = naluEnd;

    if (DECRYPT_NALU_TYPES.has(nalType)) {
      // 条件解密：仅对 type ∈ {1, 5, 25} 的 NALU 执行 XOR
      let keyOffset = 0;
      for (let pos = decryptStart; pos < decryptEnd; pos++) {
        const mapEntry = byteToTsMap[pos];
        if (mapEntry) {
          const tsByteOffset = mapEntry.payloadOffset;
          output[tsByteOffset] = pesData[pos] ^ key[keyOffset % key.length];
        }
        keyOffset++;
      }
      decryptedCount++;
    }
    // 对于其他 type 的 NALU，不解密（保留原样）

    // 继续搜索下一个 NALU
    searchOffset = nextNaluStart !== -1 ? nextNaluStart : pesData.length;
    if (nextNaluStart === -1) break;
  }

  return { naluCount, decryptedCount };
}

// ─── TS 解密 ───────────────────────────────────────

/**
 * 解密单个 ts 文件
 *
 * ⭐ 使用 scz 文章的正确 NALU 级别条件解密算法：
 *   - 不对 PES 做 PES 解码
 *   - 在 PES 数据中搜索 NAL Unit 起始码 0x000001
 *   - 仅对 nal_unit_type ∈ {1, 5, 25} 的 NAL Unit 执行 XOR 解密
 *
 * @param {Buffer} tsData - 原始 ts 文件数据
 * @param {Buffer} key - 16 字节密钥
 * @returns {Buffer} 解密后的 ts 数据
 */
function decryptTsBuffer(tsData, key) {
  const output = Buffer.alloc(tsData.length);

  // 先完整拷贝（未修改的部分保持原样）
  tsData.copy(output);

  // 遍历所有 TS 包
  for (let i = 0; i + TS_PACKET_SIZE <= tsData.length; i += TS_PACKET_SIZE) {
    if (tsData[i] !== TS_SYNC_BYTE) continue;

    const hdr = parseTsHeader(tsData.subarray(i, i + TS_PACKET_SIZE), i);

    // 只处理视频 PID
    if (!VIDEO_PIDS.has(hdr.pid)) continue;
    if (!hdr.hasPayload) continue;

    // 当 PUSI=1 时，标记 PES 起始，开始拼接并解密
    if (hdr.pusi) {
      // 拼接当前 PES 的所有 TS packet payload
      const { pesData, byteToTsMap } = buildPesFromTsPackets(tsData, i, key);

      if (pesData.length > 0) {
        // 对 PES 中的 NAL Unit 执行条件解密
        decryptNalusInPes(pesData, key, byteToTsMap, output);
      }

      // ⭐ 跳过已处理的 TS 包
      // buildPesFromTsPackets 内部已遍历到 PES 结束（i 停在 PES 最后一个包），
      // 但外层 for 循环每次迭代会 +188（i += TS_PACKET_SIZE），
      // 因此需要让 i 指向最后一个已处理包，自增后到达下一个未处理包。
      // 通过 byteToTsMap 的最后一个条目获取最后一个处理的 TS 包偏移。
      if (byteToTsMap.length > 0) {
        const lastEntry = byteToTsMap[byteToTsMap.length - 1];
        const lastPacketOffset = lastEntry.packetOffset;
        // i 设为最后一个已处理包的偏移，for 循环自增 188 后到达下一个包
        if (lastPacketOffset > i) {
          i = lastPacketOffset;
        }
      }
    }
    // 非 PUSI=1 的 TS 包（PES 中间包）会在 buildPesFromTsPackets 中一起处理
  }

  return output;
}

/**
 * 解密指定目录下的所有 ts 文件
 * @param {string} tsDir - ts 文件所在目录
 * @param {string} m3u8Url - 原始 m3u8 URL（用于提取 contentId）
 * @returns {Promise<number>} 解密成功的文件数
 */
export async function decryptTsDir(tsDir, m3u8Url) {
  const contentId = extractContentId(m3u8Url);
  const key = deriveKey(contentId);

  console.log(`[Decrypt-CCTV] contentId: ${contentId}`);
  console.log(`[Decrypt-CCTV] key: ${key.toString('hex')}`);

  const files = fs.readdirSync(tsDir)
    .filter(f => f.endsWith('.ts'))
    .sort((a, b) => {
      // 按数字排序（0.ts, 1.ts, ...）
      const numA = parseInt(a.match(/(\d+)\.ts/)?.[1] || '0', 10);
      const numB = parseInt(b.match(/(\d+)\.ts/)?.[1] || '0', 10);
      return numA - numB;
    });

  let successCount = 0;

  for (const file of files) {
    const filePath = path.join(tsDir, file);
    try {
      const rawData = fs.readFileSync(filePath);
      const decrypted = decryptTsBuffer(rawData, key);
      // 覆盖写入（原地解密）
      fs.writeFileSync(filePath, decrypted);
      successCount++;
    } catch (err) {
      console.error(`[Decrypt-CCTV] 解密失败 ${file}: ${err.message}`);
    }
  }

  console.log(`[Decrypt-CCTV] 已完成 ${successCount}/${files.length} 个 ts 文件解密`);
  return successCount;
}

/**
 * 检查是否为 CCTV 视频（通过 URL 判断是否需要解密）
 * @param {string} m3u8Url
 * @returns {boolean}
 */
export function isCctvUrl(m3u8Url) {
  if (!m3u8Url) return false;
  const cctvDomains = [
    'dh5.cntv',
    'hls.cntv',
    'cntv.qcloudcdn',
    'cntv.myhwcdn',
    'cntv.myalicdn',
    'cntv.lxdns',
  ];
  return cctvDomains.some(domain => m3u8Url.includes(domain));
}

/**
 * 使用 ffmpeg 快速封装视频（流复制，不重新编码）
 *
 * ⭐ 修复历史：原使用 -c:v libx264 重新编码，但对于 CCTV XOR 加密的输入，
 *   ffmpeg 无法正确解码"伪"h264 流，导致编码器僵死（CPU 0%，卡在 96% 不动）。
 *   改为 -c:v copy 流复制后，跳过解码-重编码，直接复用原始码流，
 *   结合 XOR 解密后的 ts 文件，快速完成封装。
 *
 * @param {string} inputPath - 输入视频文件路径
 * @param {string} outputPath - 输出视频文件路径（不含扩展名）
 * @returns {Promise<string>} 修复后的文件路径
 */
export async function fixWithFfmpeg(inputPath, outputPath) {
  const { spawn } = await import('child_process');

  return new Promise((resolve, reject) => {
    const output = `${outputPath}_FIXED.mp4`;
    const args = [
      '-i', inputPath,
      '-c:v', 'copy',          // ⭐ 流复制，不重新编码（避免 ffmpeg 僵死）
      '-c:a', 'copy',          // ⭐ 音频流复制
      '-movflags', '+faststart', // 支持流式播放
      '-y',
      output,
    ];

    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    proc.on('close', (code) => {
      if (code === 0) {
        console.log(`[Fix-Ffmpeg] 修复完成: ${output}`);
        resolve(output);
      } else {
        reject(new Error(`ffmpeg 修复失败，退出码 ${code}`));
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`启动 ffmpeg 失败: ${err.message}`));
    });
  });
}

// ─── 主入口：一键解密修复 ────────────────────────────

/**
 * 完整的 CCTV 视频解密修复流程
 * 1. 检查是否为 CCTV 视频
 * 2. 对 ts 目录执行 NALU 级别条件解密
 * 3. 使用 ffmpeg 快速封装为可播放的 mp4（流复制，不重新编码）
 *
 * @param {string} tsDir - N_m3u8DL-RE 下载的 ts 临时目录
 * @param {string} m3u8Url - m3u8 URL
 * @param {string} outputPath - 输出文件路径（不含扩展名）
 * @returns {Promise<{fixed: boolean, outputFile: string|null, message: string}>}
 */
export async function decryptAndFix(tsDir, m3u8Url, outputPath) {
  if (!isCctvUrl(m3u8Url)) {
    return { fixed: false, outputFile: null, message: '非 CCTV 视频，无需解密' };
  }

  console.log(`[Decrypt-CCTV] 开始解密修复流程...`);
  console.log(`[Decrypt-CCTV] ts目录: ${tsDir}`);
  console.log(`[Decrypt-CCTV] m3u8: ${m3u8Url.slice(0, 80)}...`);

  // 步骤1：NALU 级别条件解密 ts 文件
  const decryptedCount = await decryptTsDir(tsDir, m3u8Url);
  if (decryptedCount === 0) {
    return { fixed: false, outputFile: null, message: '未找到 ts 文件，跳过解密' };
  }

  // 步骤2：使用 ffmpeg 快速封装（流复制，不重新编码）
  // 先合并为临时 ts（使用 concat 协议）
  const concatFile = path.join(path.dirname(outputPath), `${path.basename(outputPath)}_decrypted.ts`);
  
  try {
    // 创建 concat 文件列表
    const files = fs.readdirSync(tsDir)
      .filter(f => f.endsWith('.ts'))
      .sort((a, b) => {
        const numA = parseInt(a.match(/(\d+)\.ts/)?.[1] || '0', 10);
        const numB = parseInt(b.match(/(\d+)\.ts/)?.[1] || '0', 10);
        return numA - numB;
      });

    if (files.length === 0) {
      return { fixed: false, outputFile: null, message: '解密后无 ts 文件可合并' };
    }

    // 用 ffmpeg concat 协议合并所有 ts（流复制，不重新编码）
    const fileListPath = path.join(tsDir, 'filelist.txt');
    const fileListContent = files.map(f => `file '${path.join(tsDir, f)}'`).join('\n');
    fs.writeFileSync(fileListPath, fileListContent);

    const output = `${outputPath}_FIXED.mp4`;
    const { spawn } = await import('child_process');

    await new Promise((resolve, reject) => {
      const args = [
        '-f', 'concat',
        '-safe', '0',
        '-i', fileListPath,
        '-c:v', 'copy',          // ⭐ 流复制，不重新编码（避免 ffmpeg 僵死）
        '-c:a', 'copy',          // ⭐ 音频流复制
        '-movflags', '+faststart',
        '-y',
        output,
      ];

      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg concat 失败 (${code}): ${stderr.slice(-200)}`));
        }
      });

      proc.on('error', (err) => {
        reject(new Error(`启动 ffmpeg 失败: ${err.message}`));
      });
    });

    // 清理临时文件
    try { fs.unlinkSync(fileListPath); } catch (_) {}
    try { fs.unlinkSync(concatFile); } catch (_) {}

    console.log(`[Decrypt-CCTV] ✅ 解密修复完成: ${output}`);
    return { fixed: true, outputFile: output, message: '解密修复成功' };
  } catch (err) {
    console.error(`[Decrypt-CCTV] ❌ 修复失败: ${err.message}`);
    return { fixed: false, outputFile: null, message: `修复失败: ${err.message}` };
  }
}