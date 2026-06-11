/**
 * M11S 星轨链 (Orbital Omen) 机制模拟器
 * 核心逻辑与渲染脚本 (爆发双闪与死因橙色持久版)
 */

// --- 声音合成系统 (Web Audio API) ---
class SoundManager {
    constructor() {
        this.ctx = null;
        this.enabled = true;
    }

    init() {
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
    }

    playTone(freq, type, duration, volume = 0.1) {
        if (!this.enabled) return;
        this.init();
        try {
            const osc = this.ctx.createOscillator();
            const gain = this.ctx.createGain();
            
            osc.type = type;
            osc.frequency.setValueAtTime(freq, this.ctx.currentTime);
            
            gain.gain.setValueAtTime(volume, this.ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.00001, this.ctx.currentTime + duration);
            
            osc.connect(gain);
            gain.connect(this.ctx.destination);
            
            osc.start();
            osc.stop(this.ctx.currentTime + duration);
        } catch (e) {
            console.error("Audio error", e);
        }
    }

    playNoise(duration, volume = 0.1) {
        if (!this.enabled) return;
        this.init();
        try {
            const bufferSize = this.ctx.sampleRate * duration;
            const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < bufferSize; i++) {
                data[i] = Math.random() * 2 - 1;
            }
            
            const noise = this.ctx.createBufferSource();
            noise.buffer = buffer;
            
            const filter = this.ctx.createBiquadFilter();
            filter.type = 'lowpass';
            filter.frequency.setValueAtTime(800, this.ctx.currentTime);
            
            const gain = this.ctx.createGain();
            gain.gain.setValueAtTime(volume, this.ctx.currentTime);
            gain.gain.exponentialRampToValueAtTime(0.00001, this.ctx.currentTime + duration);
            
            noise.connect(filter);
            filter.connect(gain);
            gain.connect(this.ctx.destination);
            
            noise.start();
        } catch (e) {
            console.error("Audio error", e);
        }
    }

    playStart() {
        this.playTone(440, 'triangle', 0.15, 0.15);
        setTimeout(() => this.playTone(554, 'triangle', 0.15, 0.15), 100);
        setTimeout(() => this.playTone(659, 'triangle', 0.3, 0.15), 200);
    }

    playLaser() {
        this.playNoise(0.5, 0.2);
    }

    playCleave() {
        this.playTone(120, 'sawtooth', 0.4, 0.25);
    }

    playDing() {
        this.playTone(880, 'sine', 0.15, 0.15);
        setTimeout(() => this.playTone(1320, 'sine', 0.2, 0.15), 80);
    }

    playFail() {
        this.playTone(150, 'sawtooth', 0.3, 0.3);
        setTimeout(() => this.playTone(110, 'sawtooth', 0.5, 0.3), 150);
    }

    playVictory() {
        const notes = [523, 659, 784, 1046];
        notes.forEach((freq, idx) => {
            setTimeout(() => {
                this.playTone(freq, 'sine', 0.4, 0.15);
            }, idx * 150);
        });
    }

    playTick() {
        this.playTone(600, 'sine', 0.05, 0.05);
    }
}

const sound = new SoundManager();

// --- 模拟器状态 ---
const state = {
    mode: 'click', // 'click' | 'wasd'
    gameMode: 'normal', // 'easy' | 'normal' | 'challenge'
    speed: 1.0,
    sequence: [], // [{ north: col, east: row }]
    currentWave: 0, // 0 = 读条中, 1-4 = 判定波次
    currentStep: 1, 
    isPlaying: false,
    playerPos: null, // 精确物理坐标 { x: number, y: number }
    streak: 0,
    maxStreak: 0,
    totalClears: 0,
    showPath: true,
    clickTarget: null,
    
    // 定时任务
    timer: null,
    timeouts: [],
    castProgress: 0,
    castDuration: 3500, 
    waveDuration: 1500, 
    phase: 'idle', // 'idle' | 'casting' | 'active' | 'failed' | 'victory'
    damageDownSeconds: 0,
    damageDownTimer: null,
    gotDamageDownThisRun: false,
    waveDamageChecked: { 1: false, 2: false, 3: false, 4: false },
    waveResolved: { 1: false, 2: false, 3: false, 4: false },
};

// --- SVG 配置与网格尺寸 ---
const SVG_SIZE = 500;
const GRID_MARGIN = 70;
const GRID_SIZE = 360;
const CELL_SIZE = GRID_SIZE / 4; // 90px

// 获取格子中心物理坐标
function getCellCenter(c, r) {
    return {
        x: GRID_MARGIN + c * CELL_SIZE + CELL_SIZE / 2,
        y: GRID_MARGIN + r * CELL_SIZE + CELL_SIZE / 2
    };
}

// --- 精确碰撞几何判定算法 ---

/**
 * 判断指定物理坐标点 {x, y} 在特定波次中是否安全
 * waveIndex: 1, 2, 3, 4
 */
function isPointSafe(x, y, waveIndex) {
    if (waveIndex < 1 || waveIndex > 4) return true;
    const wave = state.sequence[waveIndex - 1];
    if (!wave) return true;

    // 1. 北侧门发出的纵向激光 (列波次判定，激光中心 X 坐标，宽度 90px 即半径 45px)
    const colCenterX = GRID_MARGIN + wave.north * CELL_SIZE + CELL_SIZE / 2;
    if (Math.abs(x - colCenterX) < CELL_SIZE / 2) {
        return false;
    }

    // 2. 东侧门发出的横向激光 (行波次判定，激光中心 Y 坐标，宽度 90px 即半径 45px)
    const rowCenterY = GRID_MARGIN + wave.east * CELL_SIZE + CELL_SIZE / 2;
    if (Math.abs(y - rowCenterY) < CELL_SIZE / 2) {
        return false;
    }

    // 3. 第一波 BOSS 兽焰连尾击 (前后劈刀，正南正北各 90° 扇形切面)
    if (waveIndex === 1) {
        const dx = x - 250;
        const dy = y - 250;
        
        // 处于正中心圆心判定为不安全 (劈刀重合点)
        if (dx === 0 && dy === 0) {
            return false;
        }
        
        // 锥形扇形碰撞判定：垂直偏移距离 dy 大于水平偏移距离 dx
        if (Math.abs(dy) > Math.abs(dx)) {
            return false;
        }
    }

    return true;
}

/**
 * 检查玩家受到的伤害类型和数量
 */
function checkDamageAt(x, y, waveIndex) {
    if (waveIndex < 1 || waveIndex > 4) {
        return { hitVertical: false, hitHorizontal: false, hitFelineFury: false, totalLasers: 0, isSafe: true };
    }
    const wave = state.sequence[waveIndex - 1];
    if (!wave) {
        return { hitVertical: false, hitHorizontal: false, hitFelineFury: false, totalLasers: 0, isSafe: true };
    }

    const colCenterX = GRID_MARGIN + wave.north * CELL_SIZE + CELL_SIZE / 2;
    const hitVertical = Math.abs(x - colCenterX) < CELL_SIZE / 2;

    const rowCenterY = GRID_MARGIN + wave.east * CELL_SIZE + CELL_SIZE / 2;
    const hitHorizontal = Math.abs(y - rowCenterY) < CELL_SIZE / 2;

    let hitFelineFury = false;
    if (waveIndex === 1) {
        const dx = x - 250;
        const dy = y - 250;
        if (dx === 0 && dy === 0) {
            hitFelineFury = true;
        } else if (Math.abs(dy) > Math.abs(dx)) {
            hitFelineFury = true;
        }
    }

    const totalLasers = (hitVertical ? 1 : 0) + (hitHorizontal ? 1 : 0);
    const isSafe = !hitVertical && !hitHorizontal && !hitFelineFury;

    return {
        hitVertical,
        hitHorizontal,
        hitFelineFury,
        totalLasers,
        isSafe
    };
}

/**
 * 评估伤害并处理失败或 Debuff 逻辑
 */
function evaluateDamage(x, y, waveIndex, isTimelineResolution = false) {
    if (state.waveResolved[waveIndex]) {
        return true;
    }
    if (state.waveDamageChecked[waveIndex]) {
        return true;
    }

    const dmg = checkDamageAt(x, y, waveIndex);

    if (isTimelineResolution) {
        state.waveResolved[waveIndex] = true;
    }

    if (dmg.isSafe) {
        return true;
    }

    state.waveDamageChecked[waveIndex] = true;

    const hitBothFelineAndLaser = dmg.hitFelineFury && (dmg.totalLasers > 0);
    const hitBothLasers = dmg.totalLasers === 2;

    if (state.gameMode === 'easy') {
        if (dmg.totalLasers === 1 && !dmg.hitFelineFury) {
            if (state.damageDownSeconds > 0) {
                let reason = `在受到伤害降低状态下再次踩中了第 ${waveIndex} 回合的直线激光！`;
                triggerFailure(reason, false, true, waveIndex);
                return false;
            } else {
                applyDamageDownBuff();
                return true;
            }
        }
    }

    let reason = `踩中了第 ${waveIndex} 回合的直线激光！`;
    if (waveIndex === 1 && dmg.hitFelineFury) {
        if (dmg.totalLasers > 0) {
            reason = '第一回合同时被“兽焰连尾击”和星轨链激光击中！';
        } else {
            reason = '第一回合被“兽焰连尾击”（前后刀）劈中！';
        }
    } else if (dmg.totalLasers === 2) {
        reason = `在第 ${waveIndex} 回合同时踩中了横向与纵向的两条直线激光！`;
    }

    const forceYouDied = hitBothFelineAndLaser || hitBothLasers;
    triggerFailure(reason, false, forceYouDied, waveIndex);
    return false;
}

function applyDamageDownBuff() {
    state.gotDamageDownThisRun = true;
    if (state.damageDownTimer) {
        clearInterval(state.damageDownTimer);
    }
    state.damageDownSeconds = 30;
    updateBuffUI();
    state.damageDownTimer = setInterval(() => {
        state.damageDownSeconds--;
        if (state.damageDownSeconds <= 0) {
            clearDamageDownBuff();
        } else {
            updateBuffUI();
        }
    }, 1000);
}

function clearDamageDownBuff() {
    if (state.damageDownTimer) {
        clearInterval(state.damageDownTimer);
        state.damageDownTimer = null;
    }
    state.damageDownSeconds = 0;
    updateBuffUI();
}

function updateBuffUI() {
    const buffBar = document.getElementById('buffBar');
    if (!buffBar) return;
    if (state.damageDownSeconds > 0) {
        buffBar.style.display = 'flex';
        buffBar.innerHTML = `
            <div class="buff-icon-wrapper active">
                <img src="damage_down.png" alt="伤害降低" class="buff-icon" />
            </div>
            <div class="buff-timer-text">${state.damageDownSeconds}</div>
        `;
    } else {
        buffBar.style.display = 'none';
        buffBar.innerHTML = '';
    }
}

function showClickTargetRipple(x, y) {
    const group = document.getElementById('clickTargetGroup');
    if (group) {
        group.setAttribute('transform', `translate(${x}, ${y})`);
        group.style.display = 'block';
    }
}

function hideClickTargetRipple() {
    const group = document.getElementById('clickTargetGroup');
    if (group) {
        group.style.display = 'none';
    }
}

// 将点判定包装为格子判定，方便辅助指引线计算
function isCellSafe(c, r, waveIndex) {
    const center = getCellCenter(c, r);
    return isPointSafe(center.x, center.y, waveIndex);
}

// 随机生成星轨链
function generateSequence() {
    let northPerm, eastPerm;
    let attempts = 0;
    
    while (attempts < 100) {
        northPerm = shuffleArray([0, 1, 2, 3]);
        eastPerm = shuffleArray([0, 1, 2, 3]);
        
        const n2 = northPerm[1];
        const e2 = eastPerm[1];
        
        if ((n2 === 1 || n2 === 2) && (e2 === 1 || e2 === 2)) {
            break;
        }
        attempts++;
    }

    const seq = [];
    for (let i = 0; i < 4; i++) {
        seq.push({
            north: northPerm[i],
            east: eastPerm[i]
        });
    }
    return seq;
}

function shuffleArray(arr) {
    const newArr = [...arr];
    for (let i = newArr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newArr[i], newArr[j]] = [newArr[j], newArr[i]];
    }
    return newArr;
}

// 已移除游龙路径算法

// --- DOM 渲染函数 ---

function initSvgElements() {
    const gridLines = document.getElementById('gridLinesGroup');
    gridLines.innerHTML = '';
    
    // 渲染薄网格线
    const border = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    border.setAttribute('x', GRID_MARGIN);
    border.setAttribute('y', GRID_MARGIN);
    border.setAttribute('width', GRID_SIZE);
    border.setAttribute('height', GRID_SIZE);
    border.setAttribute('fill', 'none');
    border.setAttribute('stroke', 'rgba(160, 32, 240, 0.22)');
    border.setAttribute('stroke-width', '2');
    gridLines.appendChild(border);
    
    for (let i = 1; i < 4; i++) {
        const offset = GRID_MARGIN + i * CELL_SIZE;
        
        const vLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        vLine.setAttribute('x1', offset);
        vLine.setAttribute('y1', GRID_MARGIN);
        vLine.setAttribute('x2', offset);
        vLine.setAttribute('y2', GRID_MARGIN + GRID_SIZE);
        gridLines.appendChild(vLine);
        
        const hLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        hLine.setAttribute('x1', GRID_MARGIN);
        hLine.setAttribute('y1', offset);
        hLine.setAttribute('x2', GRID_MARGIN + GRID_SIZE);
        hLine.setAttribute('y2', offset);
        gridLines.appendChild(hLine);
    }
}

// 动态计算黑洞与白线在对应生命周期的可见性
function updateArenaVisuals(t) {
    const portalsGroup = document.getElementById('portalsGroup');
    const lasersPreviewGroup = document.getElementById('lasersPreviewGroup');
    
    portalsGroup.innerHTML = '';
    lasersPreviewGroup.innerHTML = '';

    if (state.sequence.length === 0) return;

    // 无缩放的原始秒数可见时间区间
    const portalWindows = [
        { start: 1.0, end: 9.0 },
        { start: 2.5, end: 10.5 },
        { start: 4.0, end: 12.0 },
        { start: 5.5, end: 13.5 }
    ];

    const lineWindows = [
        { start: 3.0, end: 9.0 },
        { start: 4.5, end: 10.5 },
        { start: 6.0, end: 12.0 },
        { start: 7.5, end: 13.5 }
    ];

    for (let idx = 0; idx < 4; idx++) {
        const wave = state.sequence[idx];
        const orderNum = idx + 1;

        const showPortal = (t >= portalWindows[idx].start && t < portalWindows[idx].end);
        const showLine = (t >= lineWindows[idx].start && t < lineWindows[idx].end);

        if (showPortal) {
            const nColX = GRID_MARGIN + wave.north * CELL_SIZE + CELL_SIZE / 2;
            const nPosY = 35;
            const nPortal = createPortalSvgElement(nColX, nPosY, orderNum);
            portalsGroup.appendChild(nPortal);

            const ePosX = 465;
            const eRowY = GRID_MARGIN + wave.east * CELL_SIZE + CELL_SIZE / 2;
            const ePortal = createPortalSvgElement(ePosX, eRowY, orderNum);
            portalsGroup.appendChild(ePortal);
        }

        if (showLine) {
            const nColX = GRID_MARGIN + wave.north * CELL_SIZE + CELL_SIZE / 2;
            const eRowY = GRID_MARGIN + wave.east * CELL_SIZE + CELL_SIZE / 2;
            
            // 0.2s 渐变过渡，从无到有的逐渐展现（最大不透明度 0.85）
            const lineOpacity = Math.min(0.85, ((t - lineWindows[idx].start) / 0.2) * 0.85);

            // 白色发光光线 (北)
            const nLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            nLine.setAttribute('x1', nColX);
            nLine.setAttribute('y1', 35);
            nLine.setAttribute('x2', nColX);
            nLine.setAttribute('y2', 465);
            nLine.setAttribute('class', 'laser-line-preview');
            nLine.style.strokeOpacity = lineOpacity.toString(); 
            lasersPreviewGroup.appendChild(nLine);

            // 白色发光光线 (东)
            const eLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            eLine.setAttribute('x1', 35);
            eLine.setAttribute('y1', eRowY);
            eLine.setAttribute('x2', 465);
            eLine.setAttribute('y2', eRowY);
            eLine.setAttribute('class', 'laser-line-preview');
            eLine.style.strokeOpacity = lineOpacity.toString(); 
            lasersPreviewGroup.appendChild(eLine);

            // 序号标记圈
            if (state.gameMode === 'easy') {
                const bubble = document.createElementNS('http://www.w3.org/2000/svg', 'g');
                // 序号标记圈同步渐变
                const bubbleOpacity = Math.min(1.0, (t - lineWindows[idx].start) / 0.2);
                bubble.style.opacity = bubbleOpacity.toString();

                const bCircle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                bCircle.setAttribute('cx', nColX);
                bCircle.setAttribute('cy', eRowY);
                bCircle.setAttribute('r', '11');
                bCircle.setAttribute('fill', 'rgba(255, 102, 0, 0.95)'); 
                bCircle.setAttribute('stroke', '#fff');
                bCircle.setAttribute('stroke-width', '1.5');
                bubble.appendChild(bCircle);

                const bText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                bText.setAttribute('x', nColX);
                bText.setAttribute('y', eRowY + 1);
                bText.setAttribute('text-anchor', 'middle');
                bText.setAttribute('dominant-baseline', 'middle');
                bText.setAttribute('fill', '#fff');
                bText.setAttribute('font-size', '12');
                bText.setAttribute('font-weight', 'bold');
                bText.setAttribute('font-family', 'Orbitron');
                bText.textContent = orderNum;
                bubble.appendChild(bText);
                
                lasersPreviewGroup.appendChild(bubble);
            }
        }
    }
}

function createPortalSvgElement(x, y, num) {
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    g.setAttribute('transform', `translate(${x}, ${y})`);

    const bg = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    bg.setAttribute('cx', '0');
    bg.setAttribute('cy', '0');
    bg.setAttribute('r', '18');
    bg.setAttribute('fill', 'url(#portalGrad)');
    g.appendChild(bg);


    const core = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    core.setAttribute('cx', '0');
    core.setAttribute('cy', '0');
    core.setAttribute('r', '6');
    core.setAttribute('fill', '#ff5500');
    core.setAttribute('filter', 'drop-shadow(0 0 4px #ff5500)');
    g.appendChild(core);

    return g;
}

// 渲染覆盖层（仅保留指引路线，彻底取消绿色格子安全区高亮）
function renderOverlayLayers() {

    // 1. 引导指引路线已移除
    const pathGuideGroup = document.getElementById('pathGuideGroup');
    pathGuideGroup.innerHTML = '';

    // 2. 物理渲染玩家精确标记
    const playerMarker = document.getElementById('playerMarker');
    if (state.playerPos) {
        playerMarker.setAttribute('transform', `translate(${state.playerPos.x}, ${state.playerPos.y})`);
        playerMarker.style.display = 'block';
    } else {
        playerMarker.style.display = 'none';
    }

    // 更新面板数据
    document.getElementById('currentWaveVal').textContent = `${state.currentWave} / 4`;
}

// 触发当前回合安全区的黄色双闪提示特效
function flashSafeZone(waveIndex) {
    if (waveIndex < 1 || waveIndex > 4) return;
    const lasersActiveGroup = document.getElementById('lasersActiveGroup');
    
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            if (isCellSafe(c, r, waveIndex)) {
                const center = getCellCenter(c, r);
                const x = center.x - CELL_SIZE / 2;
                const y = center.y - CELL_SIZE / 2;
                
                const safeBox = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                safeBox.setAttribute('x', x);
                safeBox.setAttribute('y', y);
                safeBox.setAttribute('width', CELL_SIZE);
                safeBox.setAttribute('height', CELL_SIZE);
                safeBox.setAttribute('class', 'safe-zone-flash');
                lasersActiveGroup.appendChild(safeBox);
            }
        }
    }
}

// 触发橙色半透明爆发双闪激光与前后大斩击 (参考图三、图二)
function triggerFireEffect(waveIndex, isCleave = false) {
    const lasersActiveGroup = document.getElementById('lasersActiveGroup');
    const wave = state.sequence[waveIndex - 1];
    if (!wave) return;

    sound.playLaser();

    // 纵向激光：爆破双闪橙色半透明
    const vLaser = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    vLaser.setAttribute('x', GRID_MARGIN + wave.north * CELL_SIZE);
    vLaser.setAttribute('y', 35);
    vLaser.setAttribute('width', CELL_SIZE);
    vLaser.setAttribute('height', 430); 
    vLaser.setAttribute('class', 'laser-active-bg');
    lasersActiveGroup.appendChild(vLaser);

    // 横向激光：爆破双闪橙色半透明
    const hLaser = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    hLaser.setAttribute('x', 35);
    hLaser.setAttribute('y', GRID_MARGIN + wave.east * CELL_SIZE);
    hLaser.setAttribute('width', 430);
    hLaser.setAttribute('height', CELL_SIZE);
    hLaser.setAttribute('class', 'laser-active-bg');
    lasersActiveGroup.appendChild(hLaser);

    // 兽焰连尾击劈刀：爆破双闪橙色半透明扇形
    if (isCleave) {
        sound.playCleave();
        const cleaveN = document.getElementById('bossCleaveNorth');
        const cleaveS = document.getElementById('bossCleaveSouth');

        cleaveN.setAttribute('d', 'M 250 250 L 0 0 L 500 0 Z');
        cleaveN.classList.add('active');

        cleaveS.setAttribute('d', 'M 250 250 L 0 500 L 500 500 Z');
        cleaveS.classList.add('active');

        const id = setTimeout(() => {
            cleaveN.classList.remove('active');
            cleaveS.classList.remove('active');
        }, 800);
        state.timeouts.push(id);
    }
}

// --- 模拟游戏流程 ---

function resetSimulator() {
    stopRealTimeTimer();
    state.timeouts.forEach(id => clearTimeout(id));
    state.timeouts = [];

    state.sequence = [];
    state.currentWave = 0;
    state.currentStep = 1;
    state.playerPos = null;
    state.phase = 'idle';
    state.isPlaying = false;
    state.clickTarget = null;
    hideClickTargetRipple();
    
    document.getElementById('portalsGroup').innerHTML = '';
    document.getElementById('lasersPreviewGroup').innerHTML = '';
    document.getElementById('lasersActiveGroup').innerHTML = '';
    document.getElementById('pathGuideGroup').innerHTML = '';
    document.getElementById('playerMarker').style.display = 'none';
    
    const cleaveN = document.getElementById('bossCleaveNorth');
    const cleaveS = document.getElementById('bossCleaveSouth');
    cleaveN.classList.remove('active');
    cleaveS.classList.remove('active');
    cleaveN.setAttribute('d', '');
    cleaveS.setAttribute('d', '');

    document.getElementById('castProgress').style.width = '0%';
    document.getElementById('castTime').textContent = '4.5s';
    document.getElementById('castTitle').textContent = '准备开始...';
    
    document.getElementById('resultBanner').classList.remove('show');
    document.getElementById('modalBackdrop').classList.remove('show');
    document.getElementById('btnModalClose').textContent = '再试一次';
    document.getElementById('castBarContainer').style.opacity = '1';
    
    clearDamageDownBuff();
    state.gotDamageDownThisRun = false;
    state.waveDamageChecked = { 1: false, 2: false, 3: false, 4: false };
    state.waveResolved = { 1: false, 2: false, 3: false, 4: false };

    updateUIControls();
}

function updateUIControls() {
    document.getElementById('currentWaveVal').textContent = `${state.currentWave} / 4`;
    document.getElementById('streakVal').textContent = state.streak;
    document.getElementById('maxStreakVal').textContent = state.maxStreak;
    document.getElementById('totalClearsVal').textContent = state.totalClears;
}

function startNewRound() {
    if (state.isPlaying) {
        state.streak = 0;
    }
    resetSimulator();
    
    state.sequence = generateSequence();
    state.isPlaying = true;

    // 默认生成位置：场地正中心物理坐标 { x: 250, y: 250 }
    state.playerPos = { x: 250, y: 250 };
    
    renderOverlayLayers();

    startSimulationLoop(); 
    sound.playStart();
}

function startSimulationLoop() {
    stopRealTimeTimer();
    
    state.triggeredEvents = {
        portal1: false, portal2: false, portal3: false, portal4: false,
        line1: false, line2: false, line3: false, line4: false,
        wave1: false, wave2: false, wave3: false, wave4: false,
        victory: false
    };

    const tickInterval = 30;
    const startTime = Date.now();
    
    state.timer = setInterval(() => {
        if (!state.isPlaying) {
            clearInterval(state.timer);
            return;
        }
        
        const elapsedRealMs = Date.now() - startTime;
        const t = (elapsedRealMs / 1000) * state.speed;
        
        // 1. 动态绘制当前时刻的黑洞与白线
        updateArenaVisuals(t);
        renderOverlayLayers();
        
        // 2. 状态阶段与读条/提示栏更新
        const castBar = document.getElementById('castBarContainer');
        if (t < 1.0) {
            state.phase = 'casting_star_chain';
            castBar.style.opacity = '1';
            const progress = (t / 1.0) * 100;
            document.getElementById('castProgress').style.width = `${progress}%`;
            document.getElementById('castTime').textContent = `${Math.max(0, 1.0 - t).toFixed(1)}s`;
            document.getElementById('castTitle').textContent = '星轨链';
        } else if (t < 4.5) {
            state.phase = 'waiting';
            castBar.style.opacity = '0';
        } else if (t < 9.0) {
            state.phase = 'casting';
            castBar.style.opacity = '1';
            const progress = ((t - 4.5) / 4.5) * 100;
            document.getElementById('castProgress').style.width = `${progress}%`;
            document.getElementById('castTime').textContent = `${Math.max(0, 9.0 - t).toFixed(1)}s`;
            document.getElementById('castTitle').textContent = '兽焰连尾击';
        } else if (t < 10.5) {
            state.phase = 'active';
            castBar.style.opacity = (state.gameMode === 'easy') ? '1' : '0';
            const progress = ((10.5 - t) / 1.5) * 100;
            document.getElementById('castProgress').style.width = `${progress}%`;
            document.getElementById('castTime').textContent = `${Math.max(0, 10.5 - t).toFixed(1)}s`;
            document.getElementById('castTitle').textContent = `第 1 回合安全！请在判定前移动到第 2 回合安全区！`;
        } else if (t < 12.0) {
            state.phase = 'active';
            castBar.style.opacity = (state.gameMode === 'easy') ? '1' : '0';
            const progress = ((12.0 - t) / 1.5) * 100;
            document.getElementById('castProgress').style.width = `${progress}%`;
            document.getElementById('castTime').textContent = `${Math.max(0, 12.0 - t).toFixed(1)}s`;
            document.getElementById('castTitle').textContent = `第 2 回合安全！请在判定前移动到第 3 回合安全区！`;
        } else if (t < 13.5) {
            state.phase = 'active';
            castBar.style.opacity = (state.gameMode === 'easy') ? '1' : '0';
            const progress = ((13.5 - t) / 1.5) * 100;
            document.getElementById('castProgress').style.width = `${progress}%`;
            document.getElementById('castTime').textContent = `${Math.max(0, 13.5 - t).toFixed(1)}s`;
            document.getElementById('castTitle').textContent = `第 3 回合安全！请在判定前移动到第 4 回合安全区！`;
        } else {
            state.phase = 'victory_pending';
            castBar.style.opacity = (state.gameMode === 'easy') ? '1' : '0';
            document.getElementById('castProgress').style.width = `0%`;
            document.getElementById('castTime').textContent = `0.0s`;
            document.getElementById('castTitle').textContent = `第 4 回合安全！判定结束中...`;
        }
        
        // 3. 事件触发器：黑洞与白线出现声音
        if (t >= 1.0 && !state.triggeredEvents.portal1) {
            state.triggeredEvents.portal1 = true;
            sound.playTone(320, 'sine', 0.08, 0.08);
        }
        if (t >= 2.5 && !state.triggeredEvents.portal2) {
            state.triggeredEvents.portal2 = true;
            sound.playTone(350, 'sine', 0.08, 0.08);
        }
        if (t >= 3.0 && !state.triggeredEvents.line1) {
            state.triggeredEvents.line1 = true;
            sound.playTone(400, 'sine', 0.05, 0.05);
        }
        if (t >= 4.0 && !state.triggeredEvents.portal3) {
            state.triggeredEvents.portal3 = true;
            sound.playTone(380, 'sine', 0.08, 0.08);
        }
        if (t >= 4.5 && !state.triggeredEvents.line2) {
            state.triggeredEvents.line2 = true;
            sound.playTone(430, 'sine', 0.05, 0.05);
        }
        if (t >= 5.5 && !state.triggeredEvents.portal4) {
            state.triggeredEvents.portal4 = true;
            sound.playTone(410, 'sine', 0.08, 0.08);
        }
        if (t >= 6.0 && !state.triggeredEvents.line3) {
            state.triggeredEvents.line3 = true;
            sound.playTone(460, 'sine', 0.05, 0.05);
        }
        if (t >= 7.5 && !state.triggeredEvents.line4) {
            state.triggeredEvents.line4 = true;
            sound.playTone(490, 'sine', 0.05, 0.05);
        }
        
        // 4. 事件触发器：波次判定结算
        if (t >= 9.0 && !state.triggeredEvents.wave1) {
            state.triggeredEvents.wave1 = true;
            state.currentWave = 1;
            
            document.getElementById('lasersActiveGroup').innerHTML = '';
            if (!evaluateDamage(state.playerPos.x, state.playerPos.y, 1, true)) {
                return;
            }
            sound.playDing();
            triggerFireEffect(1, true);
        }
        if (t >= 10.5 && !state.triggeredEvents.wave2) {
            state.triggeredEvents.wave2 = true;
            state.currentWave = 2;
            
            document.getElementById('lasersActiveGroup').innerHTML = '';
            if (!evaluateDamage(state.playerPos.x, state.playerPos.y, 2, true)) {
                return;
            }
            sound.playDing();
            triggerFireEffect(2, false);
        }
        if (t >= 12.0 && !state.triggeredEvents.wave3) {
            state.triggeredEvents.wave3 = true;
            state.currentWave = 3;
            
            document.getElementById('lasersActiveGroup').innerHTML = '';
            if (!evaluateDamage(state.playerPos.x, state.playerPos.y, 3, true)) {
                return;
            }
            sound.playDing();
            triggerFireEffect(3, false);
        }
        if (t >= 13.5 && !state.triggeredEvents.wave4) {
            state.triggeredEvents.wave4 = true;
            state.currentWave = 4;
            
            document.getElementById('lasersActiveGroup').innerHTML = '';
            if (!evaluateDamage(state.playerPos.x, state.playerPos.y, 4, true)) {
                return;
            }
            sound.playDing();
            triggerFireEffect(4, false);
        }
        
        // 5. 胜利结算
        if (t >= 14.1 && !state.triggeredEvents.victory) {
            state.triggeredEvents.victory = true;
            triggerVictory();
        }
    }, tickInterval);
}

function setMode(newMode) {
    if (state.mode === newMode) return;
    
    // 只有在初始状态（phase === 'idle'）下切换模式才不会断掉连击；在回合进行中等其他状态切换模式，均重置连击为 0
    if (state.phase !== 'idle') {
        state.streak = 0;
    }
    
    state.mode = newMode;
    
    document.getElementById('btnClickMode').classList.toggle('active', newMode === 'click');
    document.getElementById('btnWasdMode').classList.toggle('active', newMode === 'wasd');
    
    resetSimulator();
}

function stopRealTimeTimer() {
    if (state.timer) {
        clearInterval(state.timer);
        state.timer = null;
    }
}

function handleArenaClick(x, y) {
    if (!state.isPlaying || state.phase === 'failed' || state.phase === 'victory') return;

    // WASD 移动模式下，禁用鼠标点击跑位
    if (state.mode === 'wasd') return;

    state.clickTarget = { x, y };
    showClickTargetRipple(x, y);
}

// 判定失败：持久绘制致死波次的橙色半透明危险区域 (带呼吸变暗微动，参考图三)
// 绘制场地边缘外侧危险区 (爆破双闪/持久呼吸高亮)
function drawOutsideDangerZone(isFlash) {
    const lasersActiveGroup = document.getElementById('lasersActiveGroup');
    const className = isFlash ? 'laser-active-bg' : 'laser-failed-hazard';
    
    const rects = [
        { x: 0, y: 0, w: 70, h: 500 },
        { x: 430, y: 0, w: 70, h: 500 },
        { x: 70, y: 0, w: 360, h: 70 },
        { x: 70, y: 430, w: 360, h: 70 }
    ];
    
    rects.forEach(r => {
        const rectEl = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        rectEl.setAttribute('x', r.x);
        rectEl.setAttribute('y', r.y);
        rectEl.setAttribute('width', r.w);
        rectEl.setAttribute('height', r.h);
        rectEl.setAttribute('class', className);
        lasersActiveGroup.appendChild(rectEl);
    });
}

// 绘制红叉标记玩家死亡坐标
function drawDeathCross() {
    const lasersActiveGroup = document.getElementById('lasersActiveGroup');
    if (state.playerPos) {
        const cross = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        
        const line1 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line1.setAttribute('x1', state.playerPos.x - 15);
        line1.setAttribute('y1', state.playerPos.y - 15);
        line1.setAttribute('x2', state.playerPos.x + 15);
        line1.setAttribute('y2', state.playerPos.y + 15);
        line1.setAttribute('stroke', '#ff3366');
        line1.setAttribute('stroke-width', '4');
        line1.setAttribute('filter', 'drop-shadow(0 0 3px #ff3366)');
        cross.appendChild(line1);

        const line2 = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        line2.setAttribute('x1', state.playerPos.x + 15);
        line2.setAttribute('y1', state.playerPos.y - 15);
        line2.setAttribute('x2', state.playerPos.x - 15);
        line2.setAttribute('y2', state.playerPos.y + 15);
        line2.setAttribute('stroke', '#ff3366');
        line2.setAttribute('stroke-width', '4');
        line2.setAttribute('filter', 'drop-shadow(0 0 3px #ff3366)');
        cross.appendChild(line2);

        lasersActiveGroup.appendChild(cross);
    }
}

// 判定失败：持久绘制致死波次的橙色半透明危险区域 (带呼吸变暗微动，参考图三)
function triggerFailure(reason, isFallOff = false, forceYouDied = false, failedWaveIndex = null) {
    stopRealTimeTimer();
    state.phase = 'failed';
    state.isPlaying = false;
    state.streak = 0; 
    
    sound.playFail();
    updateUIControls();

    // 确保读条区域在失败时可见
    const castBar = document.getElementById('castBarContainer');
    castBar.style.opacity = '1';

    // 更新上方读条区域文字和进度
    document.getElementById('castTitle').textContent = `判定失败：${reason}`;
    document.getElementById('castProgress').style.width = '0%';
    document.getElementById('castTime').textContent = '-';

    const targetWave = failedWaveIndex !== null ? failedWaveIndex : (state.currentWave + 1);
    
    // 清空之前波次的残余临时特效，准备爆破
    document.getElementById('lasersActiveGroup').innerHTML = '';

    if (isFallOff) {
        // 边缘坠落：只触发场地外侧危险区双闪
        drawOutsideDangerZone(true);
    } else {
        // 判定失败时，场地先触发危险区特效双闪与安全区黄色双闪提示
        flashSafeZone(targetWave);
        triggerFireEffect(targetWave, targetWave === 1);
    }

    // 延迟 450ms 显示伤害结算面板及持久死因高亮，让特效闪烁更明显
    const id = setTimeout(() => {
        const banner = document.getElementById('resultBanner');
        const bannerTitle = document.getElementById('resultTitle');
        const bannerReason = document.getElementById('resultReason');
        
        bannerTitle.textContent = (isFallOff || forceYouDied) ? 'YOU DIED' : 'DAMAGE DOWN';
        bannerTitle.className = 'result-title text-danger';
        bannerReason.textContent = reason;
        banner.classList.add('show');

        if (isFallOff) {
            // 边缘坠落：只持久高亮场地外侧，并标记红叉
            document.getElementById('lasersActiveGroup').innerHTML = '';
            drawOutsideDangerZone(false);
            drawDeathCross();
        } else {
            highlightCorrectSolution(targetWave);
        }
        renderOverlayLayers();
    }, 450);
    state.timeouts.push(id);
}

// 判定失败时，在场地持久高亮死亡波次的橙色半透明危险区，并用红叉标记坐标点
function highlightCorrectSolution(waveIndex) {
    const lasersActiveGroup = document.getElementById('lasersActiveGroup');
    lasersActiveGroup.innerHTML = ''; // 清空其他过渡特效

    const wave = state.sequence[waveIndex - 1];
    if (!wave) return;

    // 1. 绘制纵向致死直线激光 (橙色半透明，带呼吸脉动)
    const vLaser = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    vLaser.setAttribute('x', GRID_MARGIN + wave.north * CELL_SIZE);
    vLaser.setAttribute('y', 35);
    vLaser.setAttribute('width', CELL_SIZE);
    vLaser.setAttribute('height', 430); 
    vLaser.setAttribute('class', 'laser-failed-hazard');
    lasersActiveGroup.appendChild(vLaser);

    // 2. 绘制横向致死直线激光 (橙色半透明，带呼吸脉动)
    const hLaser = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    hLaser.setAttribute('x', 35);
    hLaser.setAttribute('y', GRID_MARGIN + wave.east * CELL_SIZE);
    hLaser.setAttribute('width', 430);
    hLaser.setAttribute('height', CELL_SIZE);
    hLaser.setAttribute('class', 'laser-failed-hazard');
    lasersActiveGroup.appendChild(hLaser);

    // 3. 如果是第一回合，绘制 BOSS 前后大劈刀扇形致死区域 (橙色半透明，带呼吸脉动)
    if (waveIndex === 1) {
        const cleaveN = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        cleaveN.setAttribute('d', 'M 250 250 L 0 0 L 500 0 Z');
        cleaveN.setAttribute('class', 'boss-cleave-failed');
        lasersActiveGroup.appendChild(cleaveN);

        const cleaveS = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        cleaveS.setAttribute('d', 'M 250 250 L 0 500 L 500 500 Z');
        cleaveS.setAttribute('class', 'boss-cleave-failed');
        lasersActiveGroup.appendChild(cleaveS);
    }

    // 4. 绘制红叉标记玩家死亡坐标
    drawDeathCross();
}

// 机制通关
function triggerVictory() {
    stopRealTimeTimer();
    state.phase = 'victory';
    state.isPlaying = false;
    
    const isBiscuitClear = state.gotDamageDownThisRun;
    
    if (!isBiscuitClear) {
        state.streak++;
        if (state.streak > state.maxStreak) {
            state.maxStreak = state.streak;
        }
    }
    state.totalClears++;

    sound.playVictory();
    updateUIControls();

    // 更新上方读条区域文字和进度
    document.getElementById('castTitle').textContent = '机制通关：恭喜通关！';
    document.getElementById('castProgress').style.width = '100%';
    document.getElementById('castTime').textContent = 'CLEARED';

    const backdrop = document.getElementById('modalBackdrop');
    const modalTitle = document.getElementById('modalTitle');
    const modalBody = document.getElementById('modalBody');

    if (isBiscuitClear) {
        modalTitle.textContent = 'AAA小饼干批发';
        modalTitle.className = 'text-warning';
        modalBody.innerHTML = `
            <div class="modal-subtitle" style="font-size: 1.25rem; color: #ffaa00; margin-bottom: 15px; font-weight: bold; text-shadow: 0 0 5px rgba(255,170,0,0.3);">再接再厉！妈咪我下次一定不吃啦！</div>
            <p class="font-orbitron text-warning" style="font-size: 1.5rem; margin-top: 10px;">当前连胜: ${state.streak} 🔥</p>
        `;
    } else {
        modalTitle.textContent = '所以……我的星轨链爱物语果然没问题吧（？';
        modalTitle.className = 'text-success';
        modalBody.innerHTML = `
            <div class="modal-subtitle" style="font-size: 1.25rem; color: #ffaa00; margin-bottom: 15px; font-weight: bold; text-shadow: 0 0 5px rgba(255,170,0,0.3);">恭喜通关！你难道是星轨链天才！</div>
            <p class="font-orbitron text-success" style="font-size: 1.5rem; margin-top: 10px;">当前连胜: ${state.streak} 🔥</p>
        `;
    }
    document.getElementById('btnModalClose').textContent = '再链一次';
    backdrop.classList.add('show');
}

// --- 事件监听与初始化 ---

document.addEventListener('DOMContentLoaded', () => {
    initSvgElements();
    resetSimulator();

    document.getElementById('btnStart').addEventListener('click', startNewRound);
    
    document.getElementById('btnReset').addEventListener('click', () => {
        if(confirm('确定要清除当前的连胜和通关数据吗？')) {
            state.streak = 0;
            state.maxStreak = 0;
            state.totalClears = 0;
            resetSimulator();
        }
    });

    document.getElementById('btnClickMode').addEventListener('click', () => setMode('click'));
    document.getElementById('btnWasdMode').addEventListener('click', () => setMode('wasd'));

    const speedSelect = document.getElementById('speedSelect');
    state.gameMode = speedSelect.value;
    state.speed = (state.gameMode === 'challenge') ? 1.2 : 1.0;

    speedSelect.addEventListener('change', (e) => {
        if (state.phase !== 'idle') {
            state.streak = 0;
        }
        state.gameMode = e.target.value;
        state.speed = (state.gameMode === 'challenge') ? 1.2 : 1.0;
        resetSimulator();
    });

    // 辅助练习选项 DOM 已已隐藏，音效系统默认开启
    sound.enabled = true;

    document.getElementById('btnModalClose').addEventListener('click', () => {
        document.getElementById('modalBackdrop').classList.remove('show');
        if (state.phase === 'victory') {
            startNewRound(); // 胜利结算点击直接开始新的回合
        } else {
            resetSimulator();
        }
    });

    // 点击弹窗背景（弹窗以外区域）直接返回初始状态
    document.getElementById('modalBackdrop').addEventListener('click', (e) => {
        if (e.target === document.getElementById('modalBackdrop')) {
            document.getElementById('modalBackdrop').classList.remove('show');
            resetSimulator();
        }
    });

    // 结算状态时（例如失败状态），点击其他页面空白区域直接返回初始状态
    document.addEventListener('click', (e) => {
        if (state.phase === 'failed') {
            const isBtnStart = e.target.closest('#btnStart');
            const isBtnReset = e.target.closest('#btnReset');
            const isBtnMode = e.target.closest('#btnClickMode') || e.target.closest('#btnWasdMode') || e.target.closest('#speedSelect');
            const isResultBanner = e.target.closest('#resultBanner');
            if (!isBtnStart && !isBtnReset && !isBtnMode && !isResultBanner) {
                resetSimulator();
            }
        }
    });

    // 绑定竞技场透明交互层的精确点击处理
    const clickableArena = document.getElementById('clickableArena');
    clickableArena.addEventListener('click', (event) => {
        const svg = document.getElementById('arenaSvg');
        const rect = svg.getBoundingClientRect();
        
        const x = ((event.clientX - rect.left) / rect.width) * SVG_SIZE;
        const y = ((event.clientY - rect.top) / rect.height) * SVG_SIZE;
        
        const clampedX = Math.max(70, Math.min(430, x));
        const clampedY = Math.max(70, Math.min(430, y));
        
        handleArenaClick(clampedX, clampedY);
    });

    // 注入已移除的游龙路径箭头标志逻辑已清理
});

// --- WASD 键盘移动控制系统 ---
const keysPressed = {};

window.addEventListener('keydown', (e) => {
    // 1. R 键快速重开 (避开 Ctrl+R / Command+R 刷新网页)
    if (e.code === 'KeyR' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        startNewRound();
        return;
    }

    // 2. 空格键在初始状态、胜利或结束判定时直接开始新的一局
    if (e.code === 'Space') {
        if (!state.isPlaying && (state.phase === 'idle' || state.phase === 'failed' || state.phase === 'victory')) {
            e.preventDefault();
            startNewRound();
            return;
        }
    }

    // WASD 模式下的按键处理
    if (state.mode === 'wasd' && state.isPlaying) {
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyW', 'KeyS', 'KeyA', 'KeyD'].includes(e.code)) {
            e.preventDefault();
        }
        keysPressed[e.code] = true;
    }
});

window.addEventListener('keyup', (e) => {
    if (state.mode === 'wasd') {
        keysPressed[e.code] = false;
    }
});

let lastFrameTime = performance.now();
function updatePlayerMovement(timestamp) {
    requestAnimationFrame(updatePlayerMovement);
    
    const dt = (timestamp - lastFrameTime) / 1000;
    lastFrameTime = timestamp;
    
    if (!state.isPlaying || state.phase === 'failed' || state.phase === 'victory') {
        return;
    }
    
    if (state.mode === 'wasd') {
        let moveX = 0;
        let moveY = 0;
        
        if (keysPressed['KeyW'] || keysPressed['ArrowUp']) moveY -= 1;
        if (keysPressed['KeyS'] || keysPressed['ArrowDown']) moveY += 1;
        if (keysPressed['KeyA'] || keysPressed['ArrowLeft']) moveX -= 1;
        if (keysPressed['KeyD'] || keysPressed['ArrowRight']) moveX += 1;
        
        if (moveX !== 0 || moveY !== 0) {
            if (moveX !== 0 && moveY !== 0) {
                // 对角线移动速度归一化，防止斜着跑得更快
                moveX *= 0.7071;
                moveY *= 0.7071;
            }
            
            const moveSpeed = 54; 
            const dx = moveX * moveSpeed * dt;
            const dy = moveY * moveSpeed * dt;
            
            if (state.playerPos) {
                const newX = state.playerPos.x + dx;
                const newY = state.playerPos.y + dy;
                
                // 判定玩家圆心是否超出场地网格边缘 [70, 430]
                if (newX < 70 || newX > 430 || newY < 70 || newY > 430) {
                    state.playerPos.x = newX;
                    state.playerPos.y = newY;
                    renderOverlayLayers();
                    triggerFailure('真是个脚滑的家伙！这把别传……！（咽气', true);
                    return;
                }
                
                state.playerPos.x = newX;
                state.playerPos.y = newY;
                renderOverlayLayers();
            }
        }
    } else if (state.mode === 'click') {
        if (state.clickTarget && state.playerPos) {
            const dx = state.clickTarget.x - state.playerPos.x;
            const dy = state.clickTarget.y - state.playerPos.y;
            const distance = Math.hypot(dx, dy);
            
            if (distance > 0.5) {
                const moveSpeed = 54; // 6m/s = 54 SVG units/s
                const step = moveSpeed * dt;
                
                if (step >= distance) {
                    state.playerPos.x = state.clickTarget.x;
                    state.playerPos.y = state.clickTarget.y;
                    hideClickTargetRipple();
                } else {
                    state.playerPos.x += (dx / distance) * step;
                    state.playerPos.y += (dy / distance) * step;
                }
                renderOverlayLayers();
            } else {
                hideClickTargetRipple();
            }
        }
    }
}
requestAnimationFrame(updatePlayerMovement);

