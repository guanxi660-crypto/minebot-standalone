/**
 * 系统状态服务
 * 提供内存监控，支持容器/翼龙面板内存识别
 */

import os from 'os';
import fs from 'fs';

export class SystemService {
  constructor() {
    this.startTime = Date.now();
  }

  /**
   * 获取内存状态
   * 自动识别：1. 翼龙面板环境变量 2. Docker/Cgroups 限制 3. 系统物理内存
   */
  getMemoryStatus() {
    const used = process.memoryUsage().rss; // 当前进程物理内存
    let total = os.totalmem(); // 默认系统物理内存

    // 1. 尝试识别翼龙面板分配的内存上限 (环境变量)
    if (process.env.SERVER_MEMORY) {
      total = parseInt(process.env.SERVER_MEMORY) * 1024 * 1024;
    } else if (process.env.MEMORY_LIMIT) {
      // 另一种常见的环境变量
      total = parseInt(process.env.MEMORY_LIMIT) * 1024 * 1024;
    } else {
      // 2. 尝试从 Linux 容器限制文件中获取配额 (Cgroups)
      try {
        // Cgroups v1
        if (fs.existsSync('/sys/fs/cgroup/memory/memory.limit_in_bytes')) {
          const limit = parseInt(fs.readFileSync('/sys/fs/cgroup/memory/memory.limit_in_bytes', 'utf8').trim());
          // 排除无限制的情况 (9223372036854771712 是无限制的标志值)
          if (limit < 9223372036854771712) {
            total = limit;
          }
        }
        // Cgroups v2
        else if (fs.existsSync('/sys/fs/cgroup/memory.max')) {
          const limit = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
          if (limit !== 'max') {
            total = parseInt(limit);
          }
        }
      } catch (e) {
        // 忽略错误，使用默认值
      }
    }

    const percent = ((used / total) * 100).toFixed(1);
    const heapUsed = process.memoryUsage().heapUsed;
    const heapTotal = process.memoryUsage().heapTotal;

    return {
      used: (used / 1024 / 1024).toFixed(1),
      total: (total / 1024 / 1024).toFixed(0),
      percent: parseFloat(percent),
      heap: {
        used: (heapUsed / 1024 / 1024).toFixed(1),
        total: (heapTotal / 1024 / 1024).toFixed(1)
      },
      isContainerized: this.isContainerized()
    };
  }

  /**
   * 检测是否在容器环境中运行
   */
  isContainerized() {
    // 检查 Docker/.dockerenv
    if (fs.existsSync('/.dockerenv')) {
      return true;
    }

    // 检查 Cgroups
    try {
      const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
      if (cgroup.includes('docker') || cgroup.includes('kubepods') || cgroup.includes('lxc')) {
        return true;
      }
    } catch (e) {
      // 忽略错误
    }

    // 检查翼龙面板环境变量
    if (process.env.PTERODACTYL_SERVER_UUID || process.env.P_SERVER_UUID) {
      return true;
    }

    return false;
  }

  /**
   * 获取系统信息
   */
  getSystemInfo() {
    const uptime = Date.now() - this.startTime;
    const hours = Math.floor(uptime / 3600000);
    const minutes = Math.floor((uptime % 3600000) / 60000);
    const seconds = Math.floor((uptime % 60000) / 1000);

    return {
      platform: os.platform(),
      arch: os.arch(),
      nodeVersion: process.version,
      cpuCores: os.cpus().length,
      uptime: {
        ms: uptime,
        formatted: `${hours}h ${minutes}m ${seconds}s`
      },
      pid: process.pid
    };
  }

  /**
   * 获取完整状态
   */
  getStatus() {
    return {
      memory: this.getMemoryStatus(),
      system: this.getSystemInfo()
    };
  }
}
