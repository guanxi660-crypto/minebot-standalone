/**
 * Bot Behaviors - 行为模拟模块
 * 参考 minecraft-fakeplayer 实现
 */

/**
 * 跟随行为
 */
export class FollowBehavior {
  constructor(bot, goals, logFn = null, onAutoStop = null) {
    this.bot = bot;
    this.goals = goals;
    this.log = logFn;
    this.onAutoStop = onAutoStop;
    this.target = null;
    this.active = false;
    this.interval = null;
    this.minDistance = 2;
    this.maxDistance = 6;
    this.lostTicks = 0;
    this.lostLimit = 5;
  }

  start(playerName, options = {}) {
    const player = this.bot.players[playerName];
    if (!player?.entity) {
      return { success: false, message: '找不到玩家' };
    }

    this.target = playerName;
    this.active = true;
    this.lostTicks = 0;
    this.minDistance = typeof options.minDistance === 'number' ? options.minDistance : 2;
    this.maxDistance = typeof options.maxDistance === 'number' ? options.maxDistance : 6;
    if (this.maxDistance < this.minDistance) {
      this.maxDistance = this.minDistance;
    }

    // 持续跟随
    this.interval = setInterval(() => {
      if (!this.active || !this.bot) {
        this.stop();
        return;
      }

      const target = this.bot.players[this.target];
      if (target?.entity) {
        this.lostTicks = 0;
        if (!this.bot.entity) return;
        const distance = this.bot.entity.position.distanceTo(target.entity.position);
        if (distance <= this.minDistance) {
          if (this.bot?.pathfinder) this.bot.pathfinder.stop();
          return;
        }
        if (distance <= this.maxDistance) {
          return;
        }
        const goal = new this.goals.GoalFollow(target.entity, this.minDistance);
        this.bot.pathfinder.setGoal(goal, true);
      } else {
        this.lostTicks += 1;
        if (this.lostTicks >= this.lostLimit) {
          this.autoStop('target_lost');
        }
      }
    }, 1000);

    return { success: true, message: `开始跟随 ${playerName}` };
  }

  autoStop(reason = 'unknown') {
    this.active = false;
    this.target = null;
    this.lostTicks = 0;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.bot?.pathfinder) {
      this.bot.pathfinder.stop();
    }
    if (this.log && reason === 'target_lost') {
      this.log('warning', '跟随目标离开，自动停止跟随', '👣');
    }
    if (this.onAutoStop) {
      this.onAutoStop('follow', reason);
    }
  }

  stop() {
    this.active = false;
    this.target = null;
    this.lostTicks = 0;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.bot?.pathfinder) {
      this.bot.pathfinder.stop();
    }
    return { success: true, message: '停止跟随' };
  }

  getStatus() {
    return {
      active: this.active,
      target: this.target,
      minDistance: this.minDistance,
      maxDistance: this.maxDistance,
      lostTicks: this.lostTicks
    };
  }
}

/**
 * 攻击行为
 */
export class AttackBehavior {
  constructor(bot, goals, logFn = null, onAutoStop = null) {
    this.bot = bot;
    this.goals = goals;
    this.log = logFn;
    this.onAutoStop = onAutoStop;
    this.active = false;
    this.mode = 'hostile'; // hostile, all, player
    this.interval = null;
    this.range = 4;
    this.whitelist = [];
    this.minHealth = 6;
    this.lastTarget = null;
  }

  start(mode = 'hostile', options = {}) {
    this.mode = mode;
    this.active = true;
    this.range = typeof options.range === 'number' ? options.range : this.range;
    if (Array.isArray(options.whitelist)) {
      this.whitelist = options.whitelist;
    }
    if (typeof options.minHealth === 'number') {
      this.minHealth = options.minHealth;
    }

    this.interval = setInterval(() => {
      if (!this.active || !this.bot) {
        this.stop();
        return;
      }

      if (typeof this.bot.health === 'number' && this.bot.health <= this.minHealth) {
        this.autoStop('low_health');
        return;
      }

      const target = this.findTarget();
      if (target) {
        this.attackEntity(target);
      }
    }, 500);

    return { success: true, message: `开始自动攻击 (模式: ${mode})` };
  }

  findTarget() {
    if (!this.bot) return null;

    const entities = Object.values(this.bot.entities);
    let nearest = null;
    let nearestDist = this.range;

    for (const entity of entities) {
      if (!entity || entity === this.bot.entity) continue;

      if (entity.type === 'player') {
        const name = entity.username || entity.name || '';
        if (name && this.whitelist.includes(name)) continue;
      }

      const dist = this.bot.entity.position.distanceTo(entity.position);
      if (dist > nearestDist) continue;

      // 根据模式筛选目标
      if (this.mode === 'hostile') {
        if (entity.type !== 'hostile') continue;
      } else if (this.mode === 'player') {
        if (entity.type !== 'player') continue;
      }
      // mode === 'all' 时攻击所有

      nearest = entity;
      nearestDist = dist;
    }

    return nearest;
  }

  attackEntity(entity) {
    if (!this.bot || !entity) return;

    try {
      // 看向目标
      this.bot.lookAt(entity.position.offset(0, entity.height * 0.85, 0));
      // 攻击
      this.bot.attack(entity);
      this.lastTarget = entity.username || entity.name || entity.type || 'unknown';
    } catch (e) {
      // 忽略攻击错误
    }
  }

  stop() {
    this.active = false;
    this.lastTarget = null;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    return { success: true, message: '停止攻击' };
  }

  autoStop(reason = 'unknown') {
    this.active = false;
    this.lastTarget = null;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.log && reason === 'low_health') {
      this.log('warning', '生命值过低，自动停止攻击', '🛡️');
    }
    if (this.onAutoStop) {
      this.onAutoStop('attack', reason);
    }
  }

  getStatus() {
    return {
      active: this.active,
      mode: this.mode,
      range: this.range,
      minHealth: this.minHealth,
      whitelistCount: this.whitelist.length,
      lastTarget: this.lastTarget
    };
  }
}

/**
 * 巡逻行为 - 完全参考 Pathfinder PRO 实现
 */
export class PatrolBehavior {
  constructor(bot, goals, logFn = null) {
    this.bot = bot;
    this.goals = goals;
    this.log = logFn;
    this.active = false;
    this.centerPos = null;
    this.isMoving = false;
    this.patrolInterval = null;
    this.moveTimeout = null;
    this.radius = 12;
    this.waypoints = [];
    this.waypointIndex = 0;
    this.onGoalReachedBound = null;
    this.onPathStopBound = null;
  }

  start(waypoints = null) {
    // 先清理旧的监听器（防止重复绑定）
    this.cleanup();

    // 检查 bot 是否准备好
    if (!this.bot?.entity) {
      if (this.log) {
        this.log('warning', '巡逻启动失败: 机器人未就绪', '⚠️');
      }
      return { success: false, message: '机器人未就绪' };
    }

    this.active = true;
    this.isMoving = false;
    this.waypointIndex = 0;

    if (Array.isArray(waypoints) && waypoints.length > 0) {
      this.waypoints = waypoints
        .map(point => ({
          x: Number(point.x),
          y: Number(point.y),
          z: Number(point.z)
        }))
        .filter(point => !Number.isNaN(point.x) && !Number.isNaN(point.y) && !Number.isNaN(point.z));
    } else {
      this.waypoints = [];
    }

    // 记录当前位置作为中心点（和 Pathfinder PRO 一样）
    try {
      this.centerPos = this.bot.entity.position.clone();
      if (this.log) {
        this.log('info', `巡逻中心点: X:${Math.floor(this.centerPos.x)} Y:${Math.floor(this.centerPos.y)} Z:${Math.floor(this.centerPos.z)}`, '📍');
      }
    } catch (e) {
      if (this.log) {
        this.log('warning', `巡逻启动失败: ${e.message}`, '⚠️');
      }
      this.active = false;
      return { success: false, message: e.message };
    }

    // 监听到达目标
    this.onGoalReachedBound = () => {
      this.clearMoveTimeout();
      this.isMoving = false;
      if (this.log && this.active) {
        this.log('info', `巡逻到达目标点`, '📍');
      }
    };
    this.bot.on('goal_reached', this.onGoalReachedBound);

    // 监听路径停止（包括无法到达的情况）
    this.onPathStopBound = () => {
      this.clearMoveTimeout();
      this.isMoving = false;
    };
    this.bot.on('path_stop', this.onPathStopBound);

    // 每 5 秒检查一次，如果不在移动就开始移动
    this.patrolInterval = setInterval(() => {
      if (!this.active || !this.bot?.entity) return;

      if (!this.isMoving) {
        this.doMove();
      }
    }, 5000);

    // 立即开始第一次移动
    this.doMove();

    return { success: true, message: '开始巡逻' };
  }

  clearMoveTimeout() {
    if (this.moveTimeout) {
      clearTimeout(this.moveTimeout);
      this.moveTimeout = null;
    }
  }

  doMove() {
    if (!this.active || !this.bot?.entity || this.isMoving) return;
    if (!this.centerPos) {
      // 尝试重新获取中心点
      try {
        this.centerPos = this.bot.entity.position.clone();
      } catch (e) {
        return;
      }
    }

    this.isMoving = true;

    // 设置 10 秒超时，如果还没到达就强制重置
    this.clearMoveTimeout();
    this.moveTimeout = setTimeout(() => {
      if (this.isMoving && this.active) {
        if (this.log) {
          this.log('info', `巡逻移动超时，重新选择目标`, '⏱️');
        }
        this.isMoving = false;
        // 停止当前路径
        if (this.bot?.pathfinder) {
          this.bot.pathfinder.stop();
        }
      }
    }, 10000);

    if (this.waypoints.length > 0) {
      const target = this.waypoints[this.waypointIndex];
      if (this.log) {
        this.log('info', `巡逻前往: X:${Math.floor(target.x)} Y:${Math.floor(target.y)} Z:${Math.floor(target.z)}`, '🚶');
      }
      this.bot.pathfinder.setGoal(new this.goals.GoalNear(target.x, target.y, target.z, 1));
      this.waypointIndex = (this.waypointIndex + 1) % this.waypoints.length;
      return;
    }

    // 和 Pathfinder PRO 完全一样的计算方式：offset((Math.random()-0.5)*12, 0, (Math.random()-0.5)*12)
    const targetPos = this.centerPos.offset(
      (Math.random() - 0.5) * this.radius,
      0,
      (Math.random() - 0.5) * this.radius
    );

    if (this.log) {
      this.log('info', `巡逻前往: X:${Math.floor(targetPos.x)} Z:${Math.floor(targetPos.z)}`, '🚶');
    }

    // 和 Pathfinder PRO 一样使用 GoalNear
    this.bot.pathfinder.setGoal(new this.goals.GoalNear(targetPos.x, targetPos.y, targetPos.z, 1));
  }

  cleanup() {
    if (this.patrolInterval) {
      clearInterval(this.patrolInterval);
      this.patrolInterval = null;
    }

    this.clearMoveTimeout();

    if (this.bot && this.onGoalReachedBound) {
      this.bot.removeListener('goal_reached', this.onGoalReachedBound);
      this.onGoalReachedBound = null;
    }

    if (this.bot && this.onPathStopBound) {
      this.bot.removeListener('path_stop', this.onPathStopBound);
      this.onPathStopBound = null;
    }
  }

  stop() {
    this.active = false;
    this.isMoving = false;

    this.cleanup();

    // 和 Pathfinder PRO 一样：停止时清除目标
    if (this.bot?.pathfinder) {
      this.bot.pathfinder.setGoal(null);
    }

    return { success: true, message: '停止巡逻' };
  }

  getStatus() {
    return {
      active: this.active,
      isMoving: this.isMoving,
      radius: this.radius,
      waypointsCount: this.waypoints.length,
      nextWaypointIndex: this.waypoints.length > 0 ? this.waypointIndex : null,
      centerPos: this.centerPos ? {
        x: Math.round(this.centerPos.x),
        y: Math.round(this.centerPos.y),
        z: Math.round(this.centerPos.z)
      } : null
    };
  }
}

/**
 * AI 视角行为 - 自动看向附近玩家
 */
export class AiViewBehavior {
  constructor(bot) {
    this.bot = bot;
    this.active = false;
    this.interval = null;
    this.range = 16; // 检测范围
    this.lastTarget = null;
  }

  start() {
    if (this.active) return { success: false, message: 'AI 视角已在运行' };

    this.active = true;

    this.interval = setInterval(() => {
      if (!this.active || !this.bot?.entity) {
        return;
      }

      // 查找最近的玩家
      const target = this.bot.nearestEntity(entity => {
        if (!entity || entity === this.bot.entity) return false;
        if (entity.type !== 'player') return false;
        const dist = this.bot.entity.position.distanceTo(entity.position);
        return dist <= this.range;
      });

      if (target) {
        try {
          // 看向玩家头部位置
          const eyePos = target.position.offset(0, target.height * 0.85, 0);
          this.bot.lookAt(eyePos);
          this.lastTarget = target.username || target.name || 'unknown';
        } catch (e) {
          // 忽略错误
        }
      } else {
        this.lastTarget = null;
      }
    }, 500); // 每 500ms 更新一次视角

    return { success: true, message: 'AI 视角已开启' };
  }

  stop() {
    this.active = false;
    this.lastTarget = null;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    return { success: true, message: 'AI 视角已关闭' };
  }

  getStatus() {
    return {
      active: this.active,
      range: this.range,
      lastTarget: this.lastTarget
    };
  }
}

/**
 * 防踢行为 - 轻量随机动作
 */
export class AntiAfkBehavior {
  constructor(bot, logFn = null) {
    this.bot = bot;
    this.log = logFn;
    this.active = false;
    this.intervalSeconds = 45;
    this.jitterSeconds = 15;
    this.actions = ['look', 'jump', 'swing', 'sneak'];
    this.timeout = null;
    this.lastAction = null;
  }

  start(options = {}) {
    if (this.active) return { success: false, message: '防踢已在运行' };

    this.intervalSeconds = Number.isFinite(options.intervalSeconds)
      ? Math.max(5, options.intervalSeconds)
      : this.intervalSeconds;
    this.jitterSeconds = Number.isFinite(options.jitterSeconds)
      ? Math.max(0, options.jitterSeconds)
      : this.jitterSeconds;
    if (Array.isArray(options.actions) && options.actions.length > 0) {
      this.actions = options.actions.map(item => String(item));
    }

    this.active = true;
    this.scheduleNext();
    return { success: true, message: '防踢已开启' };
  }

  scheduleNext() {
    if (!this.active) return;
    const base = this.intervalSeconds * 1000;
    const jitter = this.jitterSeconds * 1000;
    const delay = Math.max(500, base + (Math.random() * 2 - 1) * jitter);
    this.timeout = setTimeout(() => {
      this.performAction();
      this.scheduleNext();
    }, delay);
  }

  performAction() {
    if (!this.active || !this.bot?.entity) return;
    const action = this.actions[Math.floor(Math.random() * this.actions.length)] || 'look';
    this.lastAction = action;

    try {
      switch (action) {
        case 'jump':
          this.bot.setControlState('jump', true);
          setTimeout(() => {
            if (this.bot) this.bot.setControlState('jump', false);
          }, 150);
          break;
        case 'swing':
          this.bot.swingArm();
          break;
        case 'sneak':
          this.bot.setControlState('sneak', true);
          setTimeout(() => {
            if (this.bot) this.bot.setControlState('sneak', false);
          }, 200);
          break;
        case 'look':
        default: {
          const pos = this.bot.entity.position;
          const target = pos.offset((Math.random() - 0.5) * 4, Math.random() * 2, (Math.random() - 0.5) * 4);
          this.bot.lookAt(target);
          break;
        }
      }
    } catch (e) {
      // ignore
    }
  }

  stop() {
    this.active = false;
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    return { success: true, message: '防踢已关闭' };
  }

  getStatus() {
    return {
      active: this.active,
      intervalSeconds: this.intervalSeconds,
      jitterSeconds: this.jitterSeconds,
      lastAction: this.lastAction
    };
  }
}

/**
 * 自动吃东西行为
 */
export class AutoEatBehavior {
  constructor(bot, logFn = null, onAutoStop = null) {
    this.bot = bot;
    this.log = logFn;
    this.onAutoStop = onAutoStop;
    this.active = false;
    this.minHealth = 6;
    this.minFood = 14;
    this.interval = null;
    this.eating = false;
    this.lastFood = null;
    this.lastNoFoodLogAt = 0;
    this.lastEatBlockedLogAt = 0;
    this.lastEatErrorLogAt = 0;
  }

  start(options = {}) {
    if (this.active) return { success: false, message: '自动吃已在运行' };

    if (Number.isFinite(options.minHealth)) {
      this.minHealth = Math.max(0, options.minHealth);
    }
    if (Number.isFinite(options.minFood)) {
      this.minFood = Math.max(0, options.minFood);
    }

    this.active = true;
    this.interval = setInterval(() => this.tick(), 1500);
    return { success: true, message: '自动吃已开启' };
  }

  getFoodPoints(item) {
    const registry = this.bot?.registry;
    if (!registry || !item) return 0;
    const foods = registry.foods || {};
    if (foods[item.name]?.foodPoints) return foods[item.name].foodPoints;
    const itemDef = registry.itemsByName?.[item.name];
    if (itemDef?.foodPoints) return itemDef.foodPoints;
    return 0;
  }

  isFoodItem(item) {
    if (!item) return false;
    const foodPoints = this.getFoodPoints(item);
    if (foodPoints > 0) return true;
    const fallbackFoods = new Set([
      'bread', 'apple', 'golden_apple', 'carrot', 'baked_potato',
      'cooked_beef', 'cooked_chicken', 'cooked_porkchop', 'cooked_mutton',
      'cooked_rabbit', 'cooked_cod', 'cooked_salmon', 'melon_slice'
    ]);
    return fallbackFoods.has(item.name);
  }

  findBestFood() {
    const items = this.bot?.inventory?.items?.() || [];
    const foods = items.filter(item => this.isFoodItem(item));
    if (foods.length === 0) return null;
    foods.sort((a, b) => this.getFoodPoints(b) - this.getFoodPoints(a));
    return foods[0];
  }

  async tick() {
    if (!this.active || !this.bot || this.eating) return;
    if (this.bot.entity?.isInWater) return;
    const health = typeof this.bot.health === 'number' ? this.bot.health : 20;
    const food = typeof this.bot.food === 'number' ? this.bot.food : 20;
    if (health > this.minHealth && food > this.minFood) return;

    const foodItem = this.findBestFood();
    if (!foodItem) {
      this.logNoFood(health, food);
      return;
    }
    if (health <= this.minHealth && food >= 20 && !['golden_apple', 'enchanted_golden_apple'].includes(foodItem.name)) {
      this.logEatBlockedByFullFood(health, food, foodItem.name);
      return;
    }

    this.eating = true;
    this.bot.__autoEating = true;
    try {
      if (this.bot?.pathfinder) this.bot.pathfinder.stop();
      if (this.bot?.setControlState) {
        this.bot.setControlState('forward', false);
        this.bot.setControlState('back', false);
        this.bot.setControlState('left', false);
        this.bot.setControlState('right', false);
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', false);
        this.bot.setControlState('sneak', false);
      }
      await this.bot.equip(foodItem, 'hand');
      if (typeof this.bot.consume === 'function') {
        await this.bot.consume();
      } else {
        this.bot.activateItem();
        await new Promise(r => setTimeout(r, 1600));
        this.bot.deactivateItem();
      }
      this.lastFood = foodItem.name;
      if (this.log) this.log('info', `自动进食: ${foodItem.name}`, '🍖');
    } catch (e) {
      this.logEatError(e);
    } finally {
      this.bot.__autoEating = false;
      this.eating = false;
    }
  }

  logNoFood(health, food) {
    if (!this.log) return;
    const now = Date.now();
    if (now - this.lastNoFoodLogAt < 10000) return;
    this.lastNoFoodLogAt = now;
    this.log('warning', `需要进食但背包没有可用食物，生命 ${health.toFixed(1)}，饱食 ${food}`, '🍖');
  }

  logEatBlockedByFullFood(health, food, foodName) {
    if (!this.log) return;
    const now = Date.now();
    if (now - this.lastEatBlockedLogAt < 10000) return;
    this.lastEatBlockedLogAt = now;
    this.log('warning', `生命值低但饱食度已满，普通食物 ${foodName} 不能直接回血`, '🍖');
  }

  logEatError(error) {
    if (!this.log) return;
    const now = Date.now();
    if (now - this.lastEatErrorLogAt < 10000) return;
    this.lastEatErrorLogAt = now;
    this.log('warning', `自动进食失败: ${error?.message || error}`, '🍖');
  }

  stop() {
    this.active = false;
    this.lastFood = null;
    if (this.bot) this.bot.__autoEating = false;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    return { success: true, message: '自动吃已关闭' };
  }

  getStatus() {
    return {
      active: this.active,
      minHealth: this.minHealth,
      minFood: this.minFood,
      lastFood: this.lastFood
    };
  }
}

/**
 * 守护行为 - 保护机器人自身
 */
export class GuardBehavior {
  constructor(bot, goals, logFn = null, onAutoStop = null) {
    this.bot = bot;
    this.goals = goals;
    this.log = logFn;
    this.onAutoStop = onAutoStop;
    this.active = false;
    this.radius = 24;
    this.attackRange = 4.5;
    this.minHealth = 12;
    this.pathCooldownMs = 800;
    this.patrolRadius = 48;
    this.patrolIntervalMs = 7000;
    this.patrolGoalTimeoutMs = 12000;
    this.interval = null;
    this.lastTarget = null;
    this.lastPathTime = 0;
    this.lastPatrolAt = 0;
    this.patrolGoalStartedAt = 0;
    this.combatStats = { attacks: 0, kills: 0 };
    this.recentAttacks = new Map();
    this.lastLoggedTarget = null;
    this.lastTargetLogAt = 0;
    this.lastAttackLogAt = 0;
    this.lastApproachLogAt = 0;
    this.lastPatrolLogAt = 0;
    this.lastLowHealthLogAt = 0;
    this.lastRetreatAt = 0;
    this.lastAvoidLogAt = 0;
    this.keepFightingAtLowHealth = true;
    this.preferredTargetId = null;
    this.currentTargetId = null;
    this.currentTargetStartedAt = 0;
    this.currentTargetLastDistance = Infinity;
    this.currentTargetLastProgressAt = 0;
    this.currentTargetDistance = null;
    this.ignoredTargets = new Map();
    this.stuckSwitchCount = 0;
    this.lastStuckLogAt = 0;
    this.onEntityHurtBound = null;
    this.onEntityDeadBound = null;
  }

  start(options = {}) {
    if (this.active) return { success: false, message: '守护已在运行' };

    if (Number.isFinite(options.radius)) {
      this.radius = Math.max(2, options.radius);
    }
    if (Number.isFinite(options.attackRange)) {
      this.attackRange = Math.max(2, options.attackRange);
    }
    if (Number.isFinite(options.minHealth)) {
      this.minHealth = Math.max(0, options.minHealth);
    }

    if (Number.isFinite(options.pathCooldownMs)) {
      this.pathCooldownMs = Math.max(300, options.pathCooldownMs);
    }
    if (Number.isFinite(options.patrolRadius)) {
      this.patrolRadius = Math.max(12, options.patrolRadius);
    }
    if (Number.isFinite(options.patrolIntervalMs)) {
      this.patrolIntervalMs = Math.max(2500, options.patrolIntervalMs);
    }
    if (Number.isFinite(options.patrolGoalTimeoutMs)) {
      this.patrolGoalTimeoutMs = Math.max(5000, options.patrolGoalTimeoutMs);
    }
    this.keepFightingAtLowHealth = options.keepFightingAtLowHealth !== false;

    this.currentTargetId = null;
    this.currentTargetStartedAt = 0;
    this.currentTargetLastDistance = Infinity;
    this.currentTargetLastProgressAt = 0;
    this.currentTargetDistance = null;
    this.ignoredTargets.clear();

    this.active = true;
    this.bindHurtTargeting();
    this.bindKillLogging();
    this.interval = setInterval(() => this.tick(), 350);
    return { success: true, message: '主动出击已开启' };
  }

  getEntityName(entity) {
    return entity?.username || entity?.name || entity?.type || 'unknown';
  }

  getEntityId(entity) {
    return entity?.id ?? entity?.uuid ?? null;
  }

  isHostileEntity(entity) {
    return !!entity && entity !== this.bot?.entity && entity.type === 'hostile' && entity.position;
  }

  isBotInWater() {
    if (!this.bot?.entity?.position || typeof this.bot.blockAt !== 'function') return !!this.bot?.entity?.isInWater;
    if (this.bot.entity.isInWater) return true;
    const pos = this.bot.entity.position;
    const feet = this.bot.blockAt(pos);
    const head = this.bot.blockAt(pos.offset(0, 1, 0));
    return feet?.name === 'water' || feet?.name === 'bubble_column' || head?.name === 'water' || head?.name === 'bubble_column';
  }

  getTargetStrategy(entity, dist) {
    return 'attack';
  }

  bindHurtTargeting() {
    if (!this.bot?.on || this.onEntityHurtBound) return;
    this.onEntityHurtBound = (entity) => {
      if (!this.active || entity !== this.bot?.entity) return;
      const target = this.findTarget();
      this.preferredTargetId = this.getEntityId(target);
    };
    this.bot.on('entityHurt', this.onEntityHurtBound);
  }

  unbindHurtTargeting() {
    if (!this.bot?.removeListener || !this.onEntityHurtBound) return;
    this.bot.removeListener('entityHurt', this.onEntityHurtBound);
    this.onEntityHurtBound = null;
  }

  bindKillLogging() {
    if (!this.bot?.on || this.onEntityDeadBound) return;
    this.onEntityDeadBound = (entity) => this.handleEntityDead(entity);
    this.bot.on('entityDead', this.onEntityDeadBound);
  }

  unbindKillLogging() {
    if (!this.bot?.removeListener || !this.onEntityDeadBound) return;
    this.bot.removeListener('entityDead', this.onEntityDeadBound);
    this.onEntityDeadBound = null;
  }

  handleEntityDead(entity) {
    const entityId = this.getEntityId(entity);
    if (entityId === null || !this.recentAttacks.has(entityId)) return;
    const record = this.recentAttacks.get(entityId);
    this.recentAttacks.delete(entityId);
    if (Date.now() - record.lastAttackAt > 15000) return;
    this.combatStats.kills += 1;
    if (this.log) {
      this.log('success', `已击杀 ${record.name}，今日战果 ${this.combatStats.kills} 个`, '🏆');
    }
  }

  cleanupIgnoredTargets(now = Date.now()) {
    for (const [entityId, ignoredUntil] of this.ignoredTargets.entries()) {
      if (ignoredUntil <= now) this.ignoredTargets.delete(entityId);
    }
  }

  isTargetIgnored(entity, now = Date.now()) {
    const entityId = this.getEntityId(entity);
    if (entityId === null) return false;
    const ignoredUntil = this.ignoredTargets.get(entityId);
    if (!ignoredUntil) return false;
    if (ignoredUntil <= now) {
      this.ignoredTargets.delete(entityId);
      return false;
    }
    return true;
  }

  resetTargetProgress(target, dist, now = Date.now()) {
    this.currentTargetId = this.getEntityId(target);
    this.currentTargetStartedAt = now;
    this.currentTargetLastDistance = dist;
    this.currentTargetLastProgressAt = now;
    this.currentTargetDistance = dist;
  }

  trackTargetProgress(target, dist, now = Date.now()) {
    const targetId = this.getEntityId(target);
    if (targetId === null) return false;
    if (this.currentTargetId !== targetId) {
      this.resetTargetProgress(target, dist, now);
      return false;
    }

    this.currentTargetDistance = dist;
    if (dist < this.currentTargetLastDistance - 0.8) {
      this.currentTargetLastDistance = dist;
      this.currentTargetLastProgressAt = now;
      return false;
    }

    const chasingTooLong = now - this.currentTargetStartedAt > 12000;
    const noProgress = now - this.currentTargetLastProgressAt > 6000;
    return chasingTooLong && noProgress && dist > this.attackRange + 0.8;
  }

  ignoreStuckTarget(target, dist, now = Date.now()) {
    const targetId = this.getEntityId(target);
    if (targetId === null) return;
    const targetName = this.getEntityName(target);
    this.ignoredTargets.set(targetId, now + 20000);
    this.stuckSwitchCount += 1;
    this.preferredTargetId = null;
    this.currentTargetId = null;
    this.currentTargetStartedAt = 0;
    this.currentTargetLastDistance = Infinity;
    this.currentTargetLastProgressAt = 0;
    this.currentTargetDistance = null;
    if (this.bot?.pathfinder) this.bot.pathfinder.stop();
    this.clearCombatControls();
    if (this.log && now - this.lastStuckLogAt > 2500) {
      this.lastStuckLogAt = now;
      this.log('warning', `追击 ${targetName} 卡住，距离 ${dist.toFixed(1)} 格，临时换目标`, '🔁');
    }
  }

  findTarget() {
    if (!this.bot?.entity) return null;
    const now = Date.now();
    this.cleanupIgnoredTargets(now);
    const origin = this.bot.entity.position;
    let preferred = null;
    let nearest = null;
    let nearestDist = this.radius;

    for (const entity of Object.values(this.bot.entities)) {
      if (!this.isHostileEntity(entity)) continue;
      if (this.isTargetIgnored(entity, now)) continue;
      const dist = origin.distanceTo(entity.position);
      if (dist > this.radius) continue;
      if (this.preferredTargetId !== null && this.getEntityId(entity) === this.preferredTargetId) {
        preferred = entity;
      }
      if (dist > nearestDist) continue;
      nearest = entity;
      nearestDist = dist;
    }

    return preferred || nearest;
  }

  tick() {
    if (!this.active || !this.bot?.entity) return;
    if (this.bot.__autoEating) {
      this.clearCombatControls();
      if (this.bot?.pathfinder) this.bot.pathfinder.stop();
      return;
    }
    const target = this.findTarget();
    if (!target) {
      this.lastTarget = null;
      this.preferredTargetId = null;
      this.currentTargetId = null;
      this.currentTargetStartedAt = 0;
      this.currentTargetLastDistance = Infinity;
      this.currentTargetLastProgressAt = 0;
      this.currentTargetDistance = null;
      this.patrolForTargets();
      return;
    }

    this.lastTarget = this.getEntityName(target);
    this.logTargetFound(this.lastTarget);
    const dist = this.bot.entity.position.distanceTo(target.position);
    const now = Date.now();
    if (this.trackTargetProgress(target, dist, now)) {
      this.ignoreStuckTarget(target, dist, now);
      return;
    }
    const strategy = this.getTargetStrategy(target, dist);
    const lowHealth = typeof this.bot.health === 'number' && this.bot.health <= this.minHealth;
    if (strategy === 'avoid') {
      this.logAvoidTarget(this.lastTarget, dist);
      if (this.bot?.pathfinder) this.bot.pathfinder.stop();
      this.clearCombatControls();
      this.retreatFromTarget(target, 700);
      return;
    }
    if (lowHealth && !this.keepFightingAtLowHealth) {
      if (this.bot?.pathfinder) this.bot.pathfinder.stop();
      this.clearCombatControls();
      this.autoStop('low_health');
      return;
    }
    if (dist > this.attackRange && this.bot?.pathfinder) {
      this.clearCombatControls();
      if (now - this.lastPathTime < this.pathCooldownMs) {
        return;
      }
      this.lastPathTime = now;
      const goal = new this.goals.GoalFollow(target, 0.8);
      this.bot.pathfinder.setGoal(goal, true);
      this.logApproach(this.lastTarget, dist);
      return;
    }

    try {
      this.bot.lookAt(target.position.offset(0, target.height * 0.85, 0));
      if (dist <= this.attackRange + 1.2) {
        if (this.bot?.pathfinder) this.bot.pathfinder.stop();
        this.pressIntoTarget(target, dist);
        if (strategy === 'attack') {
          this.bot.attack(target);
          this.logAttack(this.lastTarget, target);
        }
      }
      if (strategy === 'defend') this.retreatFromTarget(target, 650);
    } catch (e) {
      // ignore
    }
  }

  patrolForTargets() {
    if (!this.bot?.pathfinder || !this.goals?.GoalNear || !this.bot?.entity) return;
    const now = Date.now();
    if (this.bot.pathfinder.isMoving?.() && now - this.patrolGoalStartedAt < this.patrolGoalTimeoutMs) return;
    if (now - this.lastPatrolAt < this.patrolIntervalMs) return;
    this.lastPatrolAt = now;
    this.patrolGoalStartedAt = now;

    const origin = this.bot.entity.position;
    const angle = Math.random() * Math.PI * 2;
    const distance = this.patrolRadius * (0.55 + Math.random() * 0.45);
    const target = origin.offset(Math.cos(angle) * distance, 0, Math.sin(angle) * distance);
    this.bot.pathfinder.setGoal(new this.goals.GoalNear(target.x, target.y, target.z, 2));
    this.logPatrol(target, distance);
  }

  logTargetFound(targetName) {
    if (!this.log) return;
    const now = Date.now();
    if (targetName === this.lastLoggedTarget && now - this.lastTargetLogAt < 10000) return;
    this.lastLoggedTarget = targetName;
    this.lastTargetLogAt = now;
    this.log('warning', `发现目标 ${targetName}，主动出击`, '⚔️');
  }

  logApproach(targetName, dist) {
    if (!this.log) return;
    const now = Date.now();
    if (now - this.lastApproachLogAt < 2500) return;
    this.lastApproachLogAt = now;
    this.log('info', `追击 ${targetName}，距离 ${dist.toFixed(1)} 格`, '🏃');
  }

  logPatrol(target, distance) {
    if (!this.log) return;
    const now = Date.now();
    if (now - this.lastPatrolLogAt < 10000) return;
    this.lastPatrolLogAt = now;
    this.log('info', `未发现目标，向 ${Math.round(distance)} 格外巡逻搜索 X:${Math.floor(target.x)} Z:${Math.floor(target.z)}`, '🧭');
  }

  logLowHealthDefense(targetName) {
    if (!this.log) return;
    const now = Date.now();
    if (now - this.lastLowHealthLogAt < 8000) return;
    this.lastLowHealthLogAt = now;
    this.log('warning', `生命值过低，停止追击并尝试拉开距离: ${targetName}`, '🛡️');
  }

  logAvoidTarget(targetName, dist) {
    if (!this.log) return;
    const now = Date.now();
    if (now - this.lastAvoidLogAt < 5000) return;
    this.lastAvoidLogAt = now;
    this.log('warning', `守护避让高风险敌对生物: ${targetName}，距离 ${dist.toFixed(1)} 格`, '🛡️');
  }

  clearCombatControls() {
    if (!this.bot?.setControlState) return;
    this.bot.setControlState('forward', false);
    this.bot.setControlState('sprint', false);
    this.bot.setControlState('jump', false);
    this.bot.setControlState('sneak', false);
    this.bot.setControlState('back', false);
    this.bot.setControlState('left', false);
    this.bot.setControlState('right', false);
  }

  pressIntoTarget(target, dist) {
    if (!this.bot?.setControlState || !target?.position) return;
    this.bot.setControlState('back', false);
    this.bot.setControlState('sneak', false);
    this.bot.setControlState('sprint', true);
    this.bot.setControlState('forward', true);
    if (dist > this.attackRange) this.bot.setControlState('jump', true);
    const timer = setTimeout(() => {
      if (!this.bot?.setControlState) return;
      this.bot.setControlState('forward', false);
      this.bot.setControlState('sprint', false);
      this.bot.setControlState('jump', false);
    }, 450);
    timer.unref?.();
  }

  retreatFromTarget(target, durationMs = 450) {
    if (!this.bot?.setControlState || !target?.position) return;
    const now = Date.now();
    if (now - this.lastRetreatAt < 900) return;
    this.lastRetreatAt = now;
    if (this.bot?.pathfinder) this.bot.pathfinder.stop();
    this.clearCombatControls();
    this.bot.setControlState('back', true);
    this.bot.setControlState(Math.random() < 0.5 ? 'left' : 'right', true);
    this.bot.setControlState('jump', true);
    const timer = setTimeout(() => {
      if (!this.bot?.setControlState) return;
      this.bot.setControlState('back', false);
      this.bot.setControlState('left', false);
      this.bot.setControlState('right', false);
      this.bot.setControlState('jump', false);
    }, durationMs);
    timer.unref?.();
  }

  logAttack(targetName, target = null) {
    const entityId = this.getEntityId(target);
    if (entityId !== null) {
      this.recentAttacks.set(entityId, { name: targetName, lastAttackAt: Date.now() });
    }
    this.combatStats.attacks += 1;
    if (!this.log) return;
    const now = Date.now();
    if (now - this.lastAttackLogAt < 3500) return;
    this.lastAttackLogAt = now;
    this.log('info', `正在攻击 ${targetName}，累计出手 ${this.combatStats.attacks} 次`, '⚔️');
  }

  autoStop(reason = 'unknown') {
    this.active = false;
    this.lastTarget = null;
    this.preferredTargetId = null;
    this.currentTargetId = null;
    this.currentTargetStartedAt = 0;
    this.currentTargetLastDistance = Infinity;
    this.currentTargetLastProgressAt = 0;
    this.currentTargetDistance = null;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.unbindHurtTargeting();
    this.unbindKillLogging();
    if (this.bot?.pathfinder) this.bot.pathfinder.stop();
    this.clearCombatControls();
    if (this.log && reason === 'low_health') {
      this.log('warning', '生命值过低，自动停止守护', '🛡️');
    }
    if (this.onAutoStop) {
      this.onAutoStop('guard', reason);
    }
  }

  stop() {
    this.active = false;
    this.lastTarget = null;
    this.preferredTargetId = null;
    this.currentTargetId = null;
    this.currentTargetStartedAt = 0;
    this.currentTargetLastDistance = Infinity;
    this.currentTargetLastProgressAt = 0;
    this.currentTargetDistance = null;
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.unbindHurtTargeting();
    this.unbindKillLogging();
    if (this.bot?.pathfinder) this.bot.pathfinder.stop();
    this.clearCombatControls();
    return { success: true, message: '守护已关闭' };
  }

  getStatus() {
    return {
      active: this.active,
      radius: this.radius,
      attackRange: this.attackRange,
      minHealth: this.minHealth,
      patrolRadius: this.patrolRadius,
      keepFightingAtLowHealth: this.keepFightingAtLowHealth,
      attacks: this.combatStats.attacks,
      kills: this.combatStats.kills,
      stuckSwitchCount: this.stuckSwitchCount,
      ignoredTargetsCount: this.ignoredTargets.size,
      currentTargetDistance: this.currentTargetDistance,
      lastTarget: this.lastTarget
    };
  }
}

/**
 * 消息限速行为 - 限制 bot.chat 频率
 */
export class RateLimitBehavior {
  constructor(bot, logFn = null) {
    this.bot = bot;
    this.log = logFn;
    this.active = false;
    this.globalCooldownSeconds = 1;
    this.maxPerMinute = 20;
    this.lastChatTime = 0;
    this.windowStart = 0;
    this.windowCount = 0;
    this.blockedCount = 0;
    this.originalChat = null;
  }

  start(options = {}) {
    if (this.active) return { success: false, message: '限速已在运行' };

    if (Number.isFinite(options.globalCooldownSeconds)) {
      this.globalCooldownSeconds = Math.max(0, options.globalCooldownSeconds);
    }
    if (Number.isFinite(options.maxPerMinute)) {
      this.maxPerMinute = Math.max(0, options.maxPerMinute);
    }

    if (!this.bot?.chat) return { success: false, message: 'Bot 未就绪' };

    this.active = true;
    this.blockedCount = 0;
    this.originalChat = this.bot.chat.bind(this.bot);
    this.bot.chat = (message) => {
      if (!this.active) return this.originalChat(message);
      if (this.shouldBlock()) {
        this.blockedCount += 1;
        return;
      }
      return this.originalChat(message);
    };
    return { success: true, message: '限速已开启' };
  }

  shouldBlock() {
    const now = Date.now();
    const minInterval = this.globalCooldownSeconds * 1000;
    if (minInterval > 0 && now - this.lastChatTime < minInterval) {
      return true;
    }
    this.lastChatTime = now;

    if (this.maxPerMinute > 0) {
      if (!this.windowStart || now - this.windowStart > 60000) {
        this.windowStart = now;
        this.windowCount = 0;
      }
      if (this.windowCount >= this.maxPerMinute) {
        return true;
      }
      this.windowCount += 1;
    }

    return false;
  }

  stop() {
    this.active = false;
    if (this.bot && this.originalChat) {
      this.bot.chat = this.originalChat;
    }
    this.originalChat = null;
    return { success: true, message: '限速已关闭' };
  }

  getStatus() {
    return {
      active: this.active,
      globalCooldownSeconds: this.globalCooldownSeconds,
      maxPerMinute: this.maxPerMinute,
      blockedCount: this.blockedCount
    };
  }
}

/**
 * 拟人化行为 - 轻量随机动作、附近玩家反应与短距离靠近
 */
export class HumanizeBehavior {
  constructor(bot, goals = null, logFn = null) {
    this.bot = bot;
    this.goals = goals;
    this.log = logFn;
    this.active = false;
    this.intervalSeconds = 18;
    this.lookRange = 6;
    this.actionChance = 0.75;
    this.stepChance = 0.45;
    this.sneakChance = 0.25;
    this.swingChance = 0.25;
    this.stepDurationMinMs = 450;
    this.stepDurationMaxMs = 900;
    this.jumpUpEnabled = true;
    this.nearbyPlayerRange = 12;
    this.approachPlayerRange = 10;
    this.approachStopDistance = 3;
    this.playerReactionIntervalSeconds = 2;
    this.playerActionChance = 0.75;
    this.approachChance = 0.55;
    this.greetingEnabled = true;
    this.greetingChance = 0.65;
    this.greetingGlobalCooldownSeconds = 45;
    this.greetingPlayerCooldownSeconds = 180;
    this.greetingMessages = ['hi', 'hello', 'hey', 'yo', 'sup', 'morning', 'evening', 'anyone here?', 'nice place', 'cool base', 'looks busy here', 'just spawned in', 'I am checking around', 'need help?', 'all good?', 'what is up', '来了', '有人来了', '有人吗', '你也在这啊', '我看看', '路过一下', '在忙啥呢', '这边挺热闹', '我刚到', '一起看看', '这地方不错', '我站会儿', '需要帮忙吗', '你好呀', '早啊', '晚上好', '刚上线', '人不少啊', '我路过看看', '这边不错', '你们在忙啥', '看起来挺热闹', '我来转转', '别紧张'];
    this.approachGreetingMessages = ['你也来了啊', '你在这啊', '我看看你在干嘛', '这边有人啊', '哈喽', '刚过来看看', '我过来看看', '你在这干嘛', '这边有东西吗', '我跟一下', '别紧张我路过', '我看一眼', '这边安全吗', '我也来看看', 'just checking around', 'what are you doing here?', 'mind if I look?', 'I am just passing by', 'checking this spot', 'anything interesting?', 'I will follow a bit', 'looks interesting here'];
    this.leaveGreetingMessages = ['走了啊', '回头见', '我继续逛逛', '那我先走了', '一会儿见', '我去别处看看', '我继续巡逻', '待会儿回来', '先撤了', '这边看完了', '下次见', 'see ya', 'catch you later', 'I will be back', 'gonna check elsewhere', 'moving on', 'later', 'back in a bit'];
    this.hurtGreetingMessages = ['别打啊', '别别别', '打我干嘛', '我没惹你吧', '停一下停一下', '我路过的', '误会误会', '别急啊', '冷静点', '我只是看看', 'hey stop', 'why hit me?', 'chill', 'I am friendly', 'easy', 'not fighting you', 'calm down', 'my bad'];
    this.timeout = null;
    this.reactionInterval = null;
    this.greetingTimers = new Set();
    this.lastAction = null;
    this.lastReactedPlayer = null;
    this.lastInteractionAt = 0;
    this.lastGreetingAt = 0;
    this.lastLeaveGreetingAt = 0;
    this.lastHurtGreetingAt = 0;
    this.lastHurtReactionAt = 0;
    this.lastLookLogAt = 0;
    this.lastActionLogAt = 0;
    this.lastApproachLogAt = 0;
    this.lastTrackedPlayerLogAt = 0;
    this.playerGreetingTimes = new Map();
    this.playerLeaveGreetingTimes = new Map();
    this.nearbyPlayerStates = new Map();
    this.recentChatMessages = [];
    this.lastPathAt = 0;
    this.pathGoalActive = false;
    this.onEntityHurtBound = null;
  }

  start(options = {}) {
    if (this.active) return { success: false, message: '拟人已在运行' };

    if (Number.isFinite(options.intervalSeconds)) {
      this.intervalSeconds = Math.max(5, options.intervalSeconds);
    }
    if (Number.isFinite(options.lookRange)) {
      this.lookRange = Math.max(2, options.lookRange);
    }
    if (Number.isFinite(options.actionChance)) {
      this.actionChance = Math.min(1, Math.max(0, options.actionChance));
    }
    if (Number.isFinite(options.stepChance)) {
      this.stepChance = Math.min(1, Math.max(0, options.stepChance));
    }
    if (Number.isFinite(options.sneakChance)) {
      this.sneakChance = Math.min(1, Math.max(0, options.sneakChance));
    }
    if (Number.isFinite(options.swingChance)) {
      this.swingChance = Math.min(1, Math.max(0, options.swingChance));
    }
    if (Number.isFinite(options.stepDurationMinMs)) {
      this.stepDurationMinMs = Math.max(150, options.stepDurationMinMs);
    }
    if (Number.isFinite(options.stepDurationMaxMs)) {
      this.stepDurationMaxMs = Math.max(this.stepDurationMinMs, options.stepDurationMaxMs);
    }
    if (typeof options.jumpUpEnabled === 'boolean') {
      this.jumpUpEnabled = options.jumpUpEnabled;
    }
    if (Number.isFinite(options.nearbyPlayerRange)) {
      this.nearbyPlayerRange = Math.max(3, options.nearbyPlayerRange);
    }
    if (Number.isFinite(options.approachPlayerRange)) {
      this.approachPlayerRange = Math.max(4, options.approachPlayerRange);
    }
    if (Number.isFinite(options.approachStopDistance)) {
      this.approachStopDistance = Math.max(2, options.approachStopDistance);
    }
    if (Number.isFinite(options.playerReactionIntervalSeconds)) {
      this.playerReactionIntervalSeconds = Math.max(1, options.playerReactionIntervalSeconds);
    }
    if (Number.isFinite(options.playerActionChance)) {
      this.playerActionChance = Math.min(1, Math.max(0, options.playerActionChance));
    }
    if (Number.isFinite(options.approachChance)) {
      this.approachChance = Math.min(1, Math.max(0, options.approachChance));
    }
    if (typeof options.greetingEnabled === 'boolean') {
      this.greetingEnabled = options.greetingEnabled;
    }
    if (Number.isFinite(options.greetingChance)) {
      this.greetingChance = Math.min(1, Math.max(0, options.greetingChance));
    }
    if (Number.isFinite(options.greetingGlobalCooldownSeconds)) {
      this.greetingGlobalCooldownSeconds = Math.max(10, options.greetingGlobalCooldownSeconds);
    }
    if (Number.isFinite(options.greetingPlayerCooldownSeconds)) {
      this.greetingPlayerCooldownSeconds = Math.max(30, options.greetingPlayerCooldownSeconds);
    }
    if (Array.isArray(options.greetingMessages)) {
      const messages = this.normalizeChatMessages(options.greetingMessages);
      if (messages.length > 0) this.greetingMessages = messages;
    }
    if (Array.isArray(options.approachGreetingMessages)) {
      const messages = this.normalizeChatMessages(options.approachGreetingMessages);
      if (messages.length > 0) this.approachGreetingMessages = messages;
    }
    if (Array.isArray(options.leaveGreetingMessages)) {
      const messages = this.normalizeChatMessages(options.leaveGreetingMessages);
      if (messages.length > 0) this.leaveGreetingMessages = messages;
    }
    if (Array.isArray(options.hurtGreetingMessages)) {
      const messages = this.normalizeChatMessages(options.hurtGreetingMessages);
      if (messages.length > 0) this.hurtGreetingMessages = messages;
    }

    this.active = true;
    this.scheduleNext();
    this.startPlayerReactionLoop();
    this.bindHurtReaction();
    return { success: true, message: '拟人已开启' };
  }

  scheduleNext() {
    if (!this.active) return;
    const base = this.intervalSeconds * 1000;
    const jitter = Math.max(500, base * 0.35);
    const delay = Math.max(800, base + (Math.random() * 2 - 1) * jitter);
    this.timeout = setTimeout(() => {
      this.tick();
      this.scheduleNext();
    }, delay);
    this.timeout.unref?.();
  }

  startPlayerReactionLoop() {
    if (this.reactionInterval) clearInterval(this.reactionInterval);
    this.reactionInterval = setInterval(() => this.reactToNearbyPlayer(), this.playerReactionIntervalSeconds * 1000);
    this.reactionInterval.unref?.();
  }

  tick() {
    if (!this.active || !this.bot?.entity) return;
    if (this.isSurvivalPriorityActive()) return;
    if (Math.random() > this.actionChance) return;

    if (Math.random() < this.stepChance && !this.bot?.pathfinder?.isMoving()) {
      this.doStep();
      return;
    }

    if (Math.random() < this.sneakChance) {
      this.doSneak();
      return;
    }

    if (Math.random() < this.swingChance) {
      this.bot.swingArm();
      this.lastAction = 'swing';
      return;
    }

    this.doLook();
  }

  reactToNearbyPlayer() {
    if (!this.active || !this.bot?.entity) return;
    if (this.isSurvivalPriorityActive()) return;
    const now = Date.now();
    const nearbyPlayers = this.findNearbyPlayers(this.nearbyPlayerRange);
    this.handlePlayersLeaving(nearbyPlayers, now);

    const player = nearbyPlayers[0];
    if (!player?.entity) {
      this.lastReactedPlayer = null;
      return;
    }

    const distance = player.distance;
    this.lookAtPlayer(player.entity);
    this.lastReactedPlayer = player.username || player.entity.username || player.entity.name || null;
    this.logLookAtPlayer(this.lastReactedPlayer, distance, now);
    const sceneMessageSent = this.trackNearbyPlayer(player, now);

    if (now - this.lastInteractionAt > 12000 && Math.random() < this.playerActionChance) {
      this.lastInteractionAt = now;
      this.doPlayerReactionAction();
    }
    if (!sceneMessageSent) this.tryGreetPlayer(player, now);

    if (distance <= this.approachStopDistance) {
      if (this.pathGoalActive && this.bot?.pathfinder) this.bot.pathfinder.stop();
      this.pathGoalActive = false;
      return;
    }

    if (
      distance <= this.approachPlayerRange &&
      now - this.lastPathAt > 15000 &&
      Math.random() < this.approachChance &&
      !this.bot?.pathfinder?.isMoving?.()
    ) {
      this.approachPlayer(player.entity);
      this.lastPathAt = now;
    }
  }

  findNearestPlayer(range) {
    return this.findNearbyPlayers(range)[0] || null;
  }

  findNearestHostile(range) {
    if (!this.bot?.entity) return null;
    const origin = this.bot.entity.position;
    const hostiles = Object.values(this.bot.entities || [])
      .filter(entity => entity && entity !== this.bot.entity && entity.type === 'hostile' && entity.position)
      .map(entity => ({
        entity,
        name: entity.name || entity.username || entity.type || '敌对生物',
        distance: origin.distanceTo(entity.position)
      }))
      .filter(entity => entity.distance <= range)
      .sort((a, b) => a.distance - b.distance);
    return hostiles[0] || null;
  }

  findNearbyPlayers(range) {
    const nearby = [];
    const players = Object.values(this.bot.players || {});

    for (const player of players) {
      if (!player?.entity || player.entity === this.bot.entity) continue;
      const username = player.username || player.entity.username || player.entity.name;
      if (username && username === this.bot.username) continue;
      const distance = this.bot.entity.position.distanceTo(player.entity.position);
      if (distance <= range) nearby.push({ ...player, distance });
    }

    return nearby.sort((a, b) => a.distance - b.distance);
  }

  trackNearbyPlayer(player, now) {
    const username = player.username || player.entity.username || player.entity.name;
    if (!username) return false;
    const previous = this.nearbyPlayerStates.get(username);
    this.nearbyPlayerStates.set(username, { lastSeenAt: now, distance: player.distance });
    if (!previous || previous.distance > this.approachPlayerRange) {
      if (this.log && now - this.lastTrackedPlayerLogAt > 30000) {
        this.lastTrackedPlayerLogAt = now;
        this.log('info', `检测到玩家靠近: ${username}，距离 ${player.distance.toFixed(1)} 格`, '🧍');
      }
      return this.trySceneMessage(username, this.approachGreetingMessages, 'approach', now);
    }
    return false;
  }

  handlePlayersLeaving(nearbyPlayers, now) {
    const currentNames = new Set(
      nearbyPlayers
        .map(player => player.username || player.entity?.username || player.entity?.name)
        .filter(Boolean)
    );

    for (const [username, state] of this.nearbyPlayerStates.entries()) {
      if (currentNames.has(username)) continue;
      this.nearbyPlayerStates.delete(username);
      if (state.distance <= this.approachPlayerRange && now - state.lastSeenAt <= 15000) {
        if (this.log) this.log('info', `玩家离开附近: ${username}`, '🧍');
        this.tryLeaveMessage(username, now);
      }
    }
  }

  lookAtPlayer(entity) {
    this.lookAtEntity(entity);
    this.lastAction = 'look_player';
  }

  lookAtEntity(entity) {
    if (!entity?.position) return;
    const height = Number.isFinite(entity.height) ? entity.height * 0.85 : 1.6;
    this.bot.lookAt(entity.position.offset(0, height, 0));
  }

  logLookAtPlayer(username, distance, now = Date.now()) {
    if (!this.log || !username) return;
    if (now - this.lastLookLogAt < 20000) return;
    this.lastLookLogAt = now;
    this.log('info', `生存智能观察附近玩家: ${username}，距离 ${distance.toFixed(1)} 格`, '🧍');
  }

  logHumanizeAction(message, now = Date.now()) {
    if (!this.log) return;
    if (now - this.lastActionLogAt < 12000) return;
    this.lastActionLogAt = now;
    this.log('info', message, '🧍');
  }

  doPlayerReactionAction() {
    const roll = Math.random();
    if (roll < 0.35) {
      this.bot.swingArm();
      this.lastAction = 'wave_player';
      this.logHumanizeAction('生存智能对附近玩家挥手');
    } else if (roll < 0.65) {
      this.doSneak(450, 'sneak_player');
      this.logHumanizeAction('生存智能对附近玩家蹲下回应');
    } else if (roll < 0.85) {
      this.doJump();
      this.logHumanizeAction('生存智能对附近玩家跳跃回应');
    } else if (!this.bot?.pathfinder?.isMoving?.()) {
      this.doStep();
      this.lastAction = 'step_player';
      this.logHumanizeAction('生存智能在附近玩家旁边移动');
    }
  }

  tryGreetPlayer(player, now = Date.now()) {
    if (!this.greetingEnabled || !this.bot?.chat || !player?.entity) return;
    const username = player.username || player.entity.username || player.entity.name;
    if (!username || username === this.bot.username) return;
    const lastPlayerGreetingAt = this.playerGreetingTimes.get(username) || 0;
    const firstGreetingForPlayer = lastPlayerGreetingAt === 0;
    const chance = firstGreetingForPlayer ? Math.max(this.greetingChance, 0.9) : this.greetingChance;
    if (Math.random() > chance) return;
    if (!firstGreetingForPlayer && now - this.lastGreetingAt < this.greetingGlobalCooldownSeconds * 1000) return;
    if (now - lastPlayerGreetingAt < this.greetingPlayerCooldownSeconds * 1000) return;

    const message = this.pickMessage(this.greetingMessages);
    if (!message) return;
    this.lastGreetingAt = now;
    this.playerGreetingTimes.set(username, now);
    this.queueChatMessage(message, `向 ${username} 打招呼: ${message}`, 'greet_player');
  }

  trySceneMessage(username, messages, action, now = Date.now()) {
    if (!this.greetingEnabled || !this.bot?.chat || !username || username === this.bot.username) return false;
    if (now - this.lastGreetingAt < this.greetingGlobalCooldownSeconds * 1000) return false;
    const message = this.pickMessage(messages);
    if (!message) return false;
    this.lastGreetingAt = now;
    this.queueChatMessage(message, `对 ${username} 场景回应: ${message}`, `${action}_message`);
    return true;
  }

  tryLeaveMessage(username, now = Date.now()) {
    if (now - this.lastLeaveGreetingAt < this.greetingGlobalCooldownSeconds * 1000) return false;
    const lastPlayerGreetingAt = this.playerLeaveGreetingTimes.get(username) || 0;
    if (now - lastPlayerGreetingAt < this.greetingPlayerCooldownSeconds * 1000) return false;
    if (!this.trySceneMessage(username, this.leaveGreetingMessages, 'leave', now)) return false;
    this.lastLeaveGreetingAt = now;
    this.playerLeaveGreetingTimes.set(username, now);
    return true;
  }

  queueChatMessage(message, logMessage, action) {
    const delay = 500 + Math.random() * 1200;
    const timer = setTimeout(() => {
      if (!this.active || !this.bot?.chat) return;
      this.bot.chat(message);
      this.lastAction = action;
      if (this.log) this.log('chat', logMessage, '💬');
      this.greetingTimers.delete(timer);
    }, delay);
    this.greetingTimers.add(timer);
    timer.unref?.();
  }

  pickMessage(messages) {
    const cleanMessages = this.normalizeChatMessages(messages);
    if (cleanMessages.length === 0) return null;
    const candidates = cleanMessages.filter(message => !this.recentChatMessages.includes(message));
    const pool = candidates.length > 0 ? candidates : cleanMessages;
    const message = pool[Math.floor(Math.random() * pool.length)];
    this.recentChatMessages.push(message);
    if (this.recentChatMessages.length > 8) this.recentChatMessages.shift();
    return message;
  }

  normalizeChatMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages
      .map(message => String(message || '').trim())
      .filter(message => message && !message.startsWith('/'))
      .map(message => message.slice(0, 40));
  }

  isBotInWater() {
    if (!this.bot?.entity?.position || typeof this.bot.blockAt !== 'function') return !!this.bot?.entity?.isInWater;
    if (this.bot.entity.isInWater) return true;
    const pos = this.bot.entity.position;
    const feet = this.bot.blockAt(pos);
    const head = this.bot.blockAt(pos.offset(0, 1, 0));
    return feet?.name === 'water' || feet?.name === 'bubble_column' || head?.name === 'water' || head?.name === 'bubble_column';
  }

  hasNearbyHostile(range = 8) {
    if (!this.bot?.entity) return false;
    const origin = this.bot.entity.position;
    return Object.values(this.bot.entities || {}).some(entity => (
      entity &&
      entity !== this.bot.entity &&
      entity.type === 'hostile' &&
      entity.position &&
      origin.distanceTo(entity.position) <= range
    ));
  }

  isSurvivalPriorityActive() {
    return !!this.bot?.__autoEating;
  }

  bindHurtReaction() {
    if (!this.bot?.on || this.onEntityHurtBound) return;
    this.onEntityHurtBound = (entity) => this.handleEntityHurt(entity);
    this.bot.on('entityHurt', this.onEntityHurtBound);
  }

  unbindHurtReaction() {
    if (!this.bot?.removeListener || !this.onEntityHurtBound) return;
    this.bot.removeListener('entityHurt', this.onEntityHurtBound);
    this.onEntityHurtBound = null;
  }

  handleEntityHurt(entity) {
    if (!this.active || entity !== this.bot?.entity) return;
    const now = Date.now();
    if (this.isBotInWater()) {
      if (this.log && now - this.lastHurtReactionAt >= 2500) {
        this.log('warning', '机器人在水中受攻击，优先上岸自救', '🌊');
      }
      this.lastHurtReactionAt = now;
      return;
    }
    if (now - this.lastHurtReactionAt < 2500) return;
    this.lastHurtReactionAt = now;

    const player = this.findNearestPlayer(this.nearbyPlayerRange);
    const hostile = this.findNearestHostile(10);
    if (hostile?.entity) {
      this.lookAtEntity(hostile.entity);
    } else if (player?.entity) {
      this.lookAtPlayer(player.entity);
    }
    this.doBackStep();
    if (this.log) {
      const targetName = hostile?.name || player?.username || player?.entity?.username || player?.entity?.name || '未知目标';
      this.log('warning', `机器人受到攻击，后退并观察: ${targetName}`, '🧍');
    }

    if (!hostile && player?.entity && now - this.lastHurtGreetingAt >= this.greetingGlobalCooldownSeconds * 1000) {
      const username = player.username || player.entity.username || player.entity.name;
      if (this.trySceneMessage(username, this.hurtGreetingMessages, 'hurt', now)) {
        this.lastHurtGreetingAt = now;
      }
    }
  }

  approachPlayer(entity) {
    if (!this.bot?.pathfinder || !this.goals?.GoalNear || !entity?.position) return;
    const goal = new this.goals.GoalNear(
      entity.position.x,
      entity.position.y,
      entity.position.z,
      this.approachStopDistance
    );
    this.bot.pathfinder.setGoal(goal, false);
    this.pathGoalActive = true;
    this.lastAction = 'approach_player';
    const now = Date.now();
    if (this.log && now - this.lastApproachLogAt > 7000) {
      this.lastApproachLogAt = now;
      this.log('info', '生存智能尝试靠近附近玩家', '🧍');
    }
  }

  doLook() {
    const pos = this.bot.entity.position;
    const target = pos.offset(
      (Math.random() - 0.5) * this.lookRange * 2,
      Math.random() * 2,
      (Math.random() - 0.5) * this.lookRange * 2
    );
    this.bot.lookAt(target);
    this.lastAction = 'look';
  }

  doSneak(duration = 200 + Math.random() * 200, action = 'sneak') {
    this.lastAction = action;
    this.bot.setControlState('sneak', true);
    const timer = setTimeout(() => {
      if (this.bot) this.bot.setControlState('sneak', false);
    }, duration);
    timer.unref?.();
  }

  doJump() {
    this.lastAction = 'jump_player';
    this.bot.setControlState('jump', true);
    const timer = setTimeout(() => {
      if (this.bot) this.bot.setControlState('jump', false);
    }, 250);
    timer.unref?.();
  }

  doStep() {
    this.lastAction = 'step';
    this.bot.setControlState('sprint', false);
    const move = Math.random() > 0.35 ? 'forward' : 'back';
    const strafe = Math.random() > 0.5 ? 'left' : 'right';
    if (move === 'forward' && this.shouldJumpUp()) {
      this.bot.setControlState('jump', true);
      this.lastAction = 'step_jump_up';
    }
    if (Math.random() > 0.35) {
      this.bot.setControlState(move, true);
    } else {
      this.bot.setControlState(strafe, true);
    }
    const duration = this.stepDurationMinMs + Math.random() * (this.stepDurationMaxMs - this.stepDurationMinMs);
    const timer = setTimeout(() => {
      if (this.bot) {
        this.bot.setControlState(move, false);
        this.bot.setControlState(strafe, false);
        this.bot.setControlState('jump', false);
      }
    }, duration);
    timer.unref?.();
  }

  doBackStep() {
    if (!this.bot?.setControlState || this.bot?.pathfinder?.isMoving?.()) return;
    this.lastAction = 'hurt_back_step';
    this.bot.setControlState('sprint', false);
    this.bot.setControlState('back', true);
    if (Math.random() < 0.4) this.bot.setControlState('sneak', true);
    const timer = setTimeout(() => {
      if (this.bot) {
        this.bot.setControlState('back', false);
        this.bot.setControlState('sneak', false);
      }
    }, 450 + Math.random() * 450);
    timer.unref?.();
  }

  shouldJumpUp() {
    if (!this.jumpUpEnabled || !this.bot?.entity || !this.bot.blockAt) return false;
    const yaw = this.bot.entity.yaw || 0;
    const dx = -Math.sin(yaw);
    const dz = -Math.cos(yaw);
    const pos = this.bot.entity.position;
    const frontFeet = pos.offset(Math.round(dx), 0, Math.round(dz)).floored();
    const frontHead = frontFeet.offset(0, 1, 0);
    const frontAbove = frontFeet.offset(0, 2, 0);
    const feetBlock = this.bot.blockAt(frontFeet);
    const headBlock = this.bot.blockAt(frontHead);
    const aboveBlock = this.bot.blockAt(frontAbove);
    if (!feetBlock || !headBlock || !aboveBlock) return false;
    return feetBlock.boundingBox !== 'empty' && headBlock.boundingBox === 'empty' && aboveBlock.boundingBox === 'empty';
  }

  stop() {
    this.active = false;
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    if (this.reactionInterval) {
      clearInterval(this.reactionInterval);
      this.reactionInterval = null;
    }
    this.unbindHurtReaction();
    this.nearbyPlayerStates.clear();
    if (this.pathGoalActive && this.bot?.pathfinder) {
      this.bot.pathfinder.stop();
      this.pathGoalActive = false;
    }
    for (const timer of this.greetingTimers) {
      clearTimeout(timer);
    }
    this.greetingTimers.clear();
    if (this.bot?.setControlState) {
      this.bot.setControlState('sneak', false);
      this.bot.setControlState('jump', false);
    }
    return { success: true, message: '拟人已关闭' };
  }

  getStatus() {
    return {
      active: this.active,
      intervalSeconds: this.intervalSeconds,
      lookRange: this.lookRange,
      actionChance: this.actionChance,
      nearbyPlayerRange: this.nearbyPlayerRange,
      approachPlayerRange: this.approachPlayerRange,
      approachStopDistance: this.approachStopDistance,
      stepDurationMinMs: this.stepDurationMinMs,
      stepDurationMaxMs: this.stepDurationMaxMs,
      jumpUpEnabled: this.jumpUpEnabled,
      greetingEnabled: this.greetingEnabled,
      greetingChance: this.greetingChance,
      greetingGlobalCooldownSeconds: this.greetingGlobalCooldownSeconds,
      greetingPlayerCooldownSeconds: this.greetingPlayerCooldownSeconds,
      greetingMessagesCount: this.greetingMessages.length,
      approachGreetingMessagesCount: this.approachGreetingMessages.length,
      leaveGreetingMessagesCount: this.leaveGreetingMessages.length,
      hurtGreetingMessagesCount: this.hurtGreetingMessages.length,
      lastReactedPlayer: this.lastReactedPlayer,
      lastAction: this.lastAction
    };
  }
}

/**
 * 安全挂机行为 - 随机动作 + 视角 + 超时保护
 */
export class SafeIdleBehavior {
  constructor(bot, logFn = null) {
    this.bot = bot;
    this.log = logFn;
    this.active = false;
    this.intervalSeconds = 20;
    this.lookRange = 6;
    this.actionChance = 0.5;
    this.timeoutSeconds = 45;
    this.resumeDelaySeconds = 10;
    this.timeout = null;
    this.lastAction = null;
    this.lastPosition = null;
    this.lastMoveAt = 0;
    this.pausedUntil = 0;
  }

  start(options = {}) {
    if (this.active) return { success: false, message: '安全挂机已在运行' };

    if (Number.isFinite(options.intervalSeconds)) {
      this.intervalSeconds = Math.max(5, options.intervalSeconds);
    }
    if (Number.isFinite(options.lookRange)) {
      this.lookRange = Math.max(2, options.lookRange);
    }
    if (Number.isFinite(options.actionChance)) {
      this.actionChance = Math.min(1, Math.max(0, options.actionChance));
    }
    if (Number.isFinite(options.timeoutSeconds)) {
      this.timeoutSeconds = Math.max(10, options.timeoutSeconds);
    }
    if (Number.isFinite(options.resumeDelaySeconds)) {
      this.resumeDelaySeconds = Math.max(0, options.resumeDelaySeconds);
    }

    this.active = true;
    this.lastPosition = this.bot?.entity?.position?.clone?.() || null;
    this.lastMoveAt = Date.now();
    this.scheduleNext();
    return { success: true, message: '安全挂机已开启' };
  }

  scheduleNext() {
    if (!this.active) return;
    const base = this.intervalSeconds * 1000;
    const jitter = Math.max(500, base * 0.4);
    const delay = Math.max(800, base + (Math.random() * 2 - 1) * jitter);
    this.timeout = setTimeout(() => {
      this.tick();
      this.scheduleNext();
    }, delay);
  }

  tick() {
    if (!this.active || !this.bot?.entity) return;

    this.checkTimeout();
    if (this.isSurvivalPriorityActive()) return;

    if (this.pausedUntil && Date.now() < this.pausedUntil) {
      return;
    }
    if (this.pausedUntil && Date.now() >= this.pausedUntil) {
      this.pausedUntil = 0;
      this.doStep();
      this.lastAction = 'resume_step';
      if (this.log) this.log('info', '安全挂机恢复轻微移动', '⛺');
      return;
    }

    if (Math.random() > this.actionChance) return;
    const roll = Math.random();
    if (roll < 0.4) {
      this.doLook();
    } else if (roll < 0.7) {
      this.doSneak();
    } else if (roll < 0.9) {
      this.bot.swingArm();
      this.lastAction = 'swing';
    } else {
      this.doStep();
    }
  }

  isSurvivalPriorityActive() {
    if (!this.bot?.entity) return false;
    return !!this.bot.__autoEating;
  }

  checkTimeout() {
    if (!this.bot?.entity) return;
    const pos = this.bot.entity.position;
    if (this.lastPosition) {
      const moved = pos.distanceTo(this.lastPosition);
      if (moved > 0.2) {
        this.lastMoveAt = Date.now();
        this.lastPosition = pos.clone();
      }
    } else {
      this.lastPosition = pos.clone();
      this.lastMoveAt = Date.now();
    }

    const moving = this.bot?.pathfinder?.isMoving?.() || false;
    if (moving && Date.now() - this.lastMoveAt > this.timeoutSeconds * 1000) {
      if (this.bot?.pathfinder) this.bot.pathfinder.stop();
      if (this.bot?.setControlState) {
        this.bot.setControlState('sprint', false);
        this.bot.setControlState('jump', false);
        this.bot.setControlState('sneak', false);
      }
      this.lastAction = 'timeout_stop';
      this.lastMoveAt = Date.now();
      if (this.resumeDelaySeconds > 0) {
        this.pausedUntil = Date.now() + this.resumeDelaySeconds * 1000;
      }
      if (this.log) this.log('warning', '安全挂机触发超时保护，已停止移动', '⏸️');
    }
  }

  doLook() {
    const pos = this.bot.entity.position;
    const target = pos.offset(
      (Math.random() - 0.5) * this.lookRange * 2,
      Math.random() * 2,
      (Math.random() - 0.5) * this.lookRange * 2
    );
    this.bot.lookAt(target);
    this.lastAction = 'look';
  }

  doSneak() {
    this.lastAction = 'sneak';
    this.bot.setControlState('sneak', true);
    setTimeout(() => {
      if (this.bot) this.bot.setControlState('sneak', false);
    }, 200 + Math.random() * 200);
  }

  doStep() {
    this.lastAction = 'step';
    this.bot.setControlState('sprint', false);
    const move = Math.random() > 0.5 ? 'forward' : 'back';
    const strafe = Math.random() > 0.5 ? 'left' : 'right';
    if (Math.random() > 0.5) {
      this.bot.setControlState(move, true);
    } else {
      this.bot.setControlState(strafe, true);
    }
    setTimeout(() => {
      if (this.bot) {
        this.bot.setControlState(move, false);
        this.bot.setControlState(strafe, false);
      }
    }, 160 + Math.random() * 220);
  }

  stop() {
    this.active = false;
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
    return { success: true, message: '安全挂机已关闭' };
  }

  getStatus() {
    return {
      active: this.active,
      intervalSeconds: this.intervalSeconds,
      lookRange: this.lookRange,
      actionChance: this.actionChance,
      timeoutSeconds: this.timeoutSeconds,
      resumeDelaySeconds: this.resumeDelaySeconds,
      lastAction: this.lastAction
    };
  }
}

/**
 * 任务脚本 - 巡逻 -> 休息
 */
export class WorkflowBehavior {
  constructor(bot, controller, logFn = null) {
    this.bot = bot;
    this.controller = controller;
    this.log = logFn;
    this.active = false;
    this.steps = ['patrol', 'rest'];
    this.currentIndex = 0;
    this.patrolSeconds = 120;
    this.restSeconds = 40;
    this.stepTimer = null;
    this.startedAt = 0;
    this.lastReason = null;
  }

  start(options = {}) {
    if (this.active) return { success: false, message: '任务脚本已在运行' };

    if (Array.isArray(options.steps) && options.steps.length > 0) {
      const steps = options.steps.map(step => String(step)).filter(step => step !== 'mining');
      this.steps = steps.length > 0 ? steps : ['patrol', 'rest'];
    }
    if (Number.isFinite(options.patrolSeconds)) {
      this.patrolSeconds = Math.max(10, options.patrolSeconds);
    }
    if (Number.isFinite(options.restSeconds)) {
      this.restSeconds = Math.max(5, options.restSeconds);
    }

    this.active = true;
    this.currentIndex = 0;
    this.lastReason = null;
    this.startStep();
    return { success: true, message: '任务脚本已开启' };
  }

  startStep() {
    if (!this.active) return;
    const step = this.steps[this.currentIndex] || 'rest';
    this.startedAt = Date.now();
    this.clearTimer();

    switch (step) {
      case 'patrol':
        {
          const result = this.controller.startPatrol?.();
          if (result && result.success === false) {
            this.completeStep('failed');
            return;
          }
        }
        this.stepTimer = setTimeout(() => this.completeStep('timeout'), this.patrolSeconds * 1000);
        break;
      case 'rest':
      default:
        this.controller.stopAllMovement?.();
        this.stepTimer = setTimeout(() => this.completeStep('timeout'), this.restSeconds * 1000);
        break;
    }
  }

  completeStep(reason = 'done') {
    if (!this.active) return;
    const step = this.steps[this.currentIndex] || 'rest';
    this.lastReason = `${step}:${reason}`;
    if (step === 'patrol') this.controller.stopPatrol?.();
    if (step === 'rest') this.controller.stopAllMovement?.();
    this.currentIndex = (this.currentIndex + 1) % this.steps.length;
    this.startStep();
  }

  onStepComplete(step, reason = 'done') {
    const current = this.steps[this.currentIndex];
    if (!this.active || current !== step) return;
    this.completeStep(reason);
  }

  stop() {
    this.active = false;
    this.clearTimer();
    this.controller.stopPatrol?.();
    this.controller.stopAllMovement?.();
    return { success: true, message: '任务脚本已关闭' };
  }

  clearTimer() {
    if (this.stepTimer) {
      clearTimeout(this.stepTimer);
      this.stepTimer = null;
    }
  }

  getStatus() {
    const step = this.steps[this.currentIndex] || 'rest';
    const elapsed = this.startedAt ? Math.floor((Date.now() - this.startedAt) / 1000) : 0;
    return {
      active: this.active,
      step,
      steps: this.steps,
      elapsedSeconds: elapsed,
      lastReason: this.lastReason
    };
  }
}

/**
 * 动作行为 - 模拟玩家动作
 */
export class ActionBehavior {
  constructor(bot) {
    this.bot = bot;
    this.loopInterval = null;
    this.actions = [];
    this.looping = false;
  }

  // 跳跃
  jump() {
    if (!this.bot) return;
    this.bot.setControlState('jump', true);
    setTimeout(() => {
      if (this.bot) this.bot.setControlState('jump', false);
    }, 100);
    return { success: true, message: '跳跃' };
  }

  // 蹲下
  sneak(enabled = true) {
    if (!this.bot) return;
    this.bot.setControlState('sneak', enabled);
    return { success: true, message: enabled ? '蹲下' : '站起' };
  }

  // 冲刺
  sprint(enabled = true) {
    if (!this.bot) return;
    this.bot.setControlState('sprint', enabled);
    return { success: true, message: enabled ? '冲刺' : '停止冲刺' };
  }

  // 使用物品 (右键)
  useItem() {
    if (!this.bot) return;
    this.bot.activateItem();
    return { success: true, message: '使用物品' };
  }

  // 放下物品
  deactivateItem() {
    if (!this.bot) return;
    this.bot.deactivateItem();
    return { success: true, message: '放下物品' };
  }

  // 左键攻击/挖掘
  swing() {
    if (!this.bot) return;
    this.bot.swingArm();
    return { success: true, message: '挥动手臂' };
  }

  // 看向位置
  lookAt(x, y, z) {
    if (!this.bot) return;
    this.bot.lookAt({ x, y, z });
    return { success: true, message: `看向 (${x}, ${y}, ${z})` };
  }

  // 循环执行动作
  startLoop(actionList, intervalMs = 1000) {
    this.actions = actionList;
    this.looping = true;
    let index = 0;

    this.loopInterval = setInterval(() => {
      if (!this.looping || !this.bot) {
        this.stopLoop();
        return;
      }

      const action = this.actions[index];
      this.executeAction(action);
      index = (index + 1) % this.actions.length;
    }, intervalMs);

    return { success: true, message: `开始循环动作 (${actionList.length} 个)` };
  }

  executeAction(action) {
    switch (action.type) {
      case 'jump':
        this.jump();
        break;
      case 'sneak':
        this.sneak(action.enabled);
        break;
      case 'sprint':
        this.sprint(action.enabled);
        break;
      case 'useItem':
        this.useItem();
        break;
      case 'swing':
        this.swing();
        break;
      case 'lookAt':
        this.lookAt(action.x, action.y, action.z);
        break;
    }
  }

  stopLoop() {
    this.looping = false;
    if (this.loopInterval) {
      clearInterval(this.loopInterval);
      this.loopInterval = null;
    }
    return { success: true, message: '停止循环动作' };
  }

  getStatus() {
    return {
      looping: this.looping,
      actionsCount: this.actions.length
    };
  }
}

/**
 * 行为管理器 - 统一管理所有行为
 */
export class BehaviorManager {
  constructor(bot, goals, logFn = null, onAutoStop = null, controller = null) {
    this.bot = bot;
    this.goals = goals;
    this.log = logFn;
    this.onAutoStop = onAutoStop;

    this.follow = new FollowBehavior(bot, goals, logFn, onAutoStop);
    this.attack = new AttackBehavior(bot, goals, logFn, onAutoStop);
    this.patrol = new PatrolBehavior(bot, goals, logFn); // 传递日志函数
    this.action = new ActionBehavior(bot);
    this.aiView = new AiViewBehavior(bot);
    this.antiAfk = new AntiAfkBehavior(bot, logFn);
    this.autoEat = new AutoEatBehavior(bot, logFn, onAutoStop);
    this.guard = new GuardBehavior(bot, goals, logFn, onAutoStop);
    this.rateLimit = new RateLimitBehavior(bot, logFn);
    this.humanize = new HumanizeBehavior(bot, goals, logFn);
    this.safeIdle = new SafeIdleBehavior(bot, logFn);
    this.workflow = new WorkflowBehavior(bot, controller, logFn);
  }

  stopAll() {
    this.follow.stop();
    this.attack.stop();
    this.patrol.stop();
    this.action.stopLoop();
    this.aiView.stop();
    this.antiAfk.stop();
    this.autoEat.stop();
    this.guard.stop();
    this.rateLimit.stop();
    this.humanize.stop();
    this.safeIdle.stop();
    this.workflow.stop();
    return { success: true, message: '已停止所有行为' };
  }

  getStatus() {
    return {
      follow: this.follow.getStatus(),
      attack: this.attack.getStatus(),
      patrol: this.patrol.getStatus(),
      action: this.action.getStatus(),
      aiView: this.aiView.getStatus(),
      antiAfk: this.antiAfk.getStatus(),
      autoEat: this.autoEat.getStatus(),
      guard: this.guard.getStatus(),
      rateLimit: this.rateLimit.getStatus(),
      humanize: this.humanize.getStatus(),
      safeIdle: this.safeIdle.getStatus(),
      workflow: this.workflow.getStatus()
    };
  }
}
