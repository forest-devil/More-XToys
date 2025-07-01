// ==UserScript==
// @name          Xtoys 玩具多多
// @namespace     https://github.com/forest-devil/
// @version       1.14
// @description   利用XToys的串行接口支持更多蓝牙玩具。
// @author        forest-devil & Gemini
// @license       Apache
// @match         https://xtoys.app/*
// @grant         unsafeWindow
// @grant         GM_log
// @grant         GM_registerMenuCommand
// @grant         GM_unregisterMenuCommand
// @grant         GM_getValue
// @grant         GM_setValue
// @run-at        document-start
// @icon          https://xtoys.app/icons/favicon-96x96.png
// @downloadURL   https://raw.githubusercontent.com/forest-devil/More-XToys/main/userscript.js
// @updateURL     https://raw.githubusercontent.com/forest-devil/More-XToys/main/userscript.js
// ==/UserScript==

(function() {
    'use strict';

    // --- 配置区域 ---
    /**
     * @type {boolean} 调试模式开关
     * 设置为 true: 启用无设备调试模式。脚本将不会连接真实蓝牙设备，而是将数据流打印到控制台。
     * 设置为 false: 正常模式，脚本将尝试连接真实的蓝牙设备。
     */
    // 从存储中加载调试模式状态，如果未设置则默认为 false
    let DEBUG_MODE = GM_getValue("DEBUG_MODE", false);

    // 用于调试模式下生成友好设备名的计数器
    // 每次脚本启动时重置为 0，以满足刷新页面后从 #1 开始的需求
    let debugDeviceCounter = 0;

    // --- 模拟 USB ID 常量 ---
    // 这些常量用于为模拟串口设备创建唯一的 USB ID
    // MOCK_USB_VENDOR_ID 代表我们模拟设备的通用制造商 ID
    const MOCK_USB_VENDOR_ID = 0x1A86;
    // MOCK_USB_PRODUCT_ID_BASE 提供了产品 ID 的起始基数，用于生成唯一 ID
    const MOCK_USB_PRODUCT_ID_BASE = 0x7523;

    // 一个全局 Map，用于存储活跃的可写流，键是唯一的标识符 (device.id 或 JSON 中的 id)
    // 这允许我们根据 JSON 负载中的 'id' 字段将命令路由到特定设备。
    /** @type {Map<string, WritableStream>} */
    const activeCommandStreams = new Map();

    // 注册菜单命令来切换调试模式
    GM_registerMenuCommand(
        `切换调试模式 (当前: ${DEBUG_MODE ? '开启' : '关闭'})`, // 菜单项显示的文本
        toggleDebugMode
    );

    function toggleDebugMode() {
        DEBUG_MODE = !DEBUG_MODE; // 切换状态
        GM_setValue("DEBUG_MODE", DEBUG_MODE); // 保存新状态
        console.log(`[Xtoys 玩具多多] 调试模式: ${DEBUG_MODE ? '已开启' : '已关闭'}`);
        // 涉及关键工作模式，强制刷新，菜单将自动关闭并在重新载入时更新文本
        location.reload();
    }

    // 在这里定义所有支持的蓝牙协议
    const PROTOCOLS = {
        "Roussan": {
            serviceUUID: "fe400001-b5a3-f393-e0a9-e50e24dcca9e",
            writeUUID: "fe400002-b5a3-f393-e0a9-e50e24dcca9e",
            notifyUUID: "fe400003-b5a3-f393-e0a9-e50e24dcca9e",
            /**
             * 将输入的指令转换为蓝牙数据包
             * @param {object} command - 从模拟串口接收到的JSON对象
             * @returns {Uint8Array | null} - 转换后的数据包或在无效输入时返回null
             */
            transform: function(command) {
                // 优先使用 vibrate，其次是 Speed
                let speed = command.vibrate ?? command.Speed ?? null;
                if (speed === null) {
                    console.warn('[Xtoys 玩具多多] 指令对象中不包含 "vibrate" 或 "Speed" 键。', command);
                    return null;
                }
                // 确保速度值在 0-100 范围内
                speed = Math.max(0, Math.min(100, parseInt(speed, 10)));
                // 封装数据包: 55 AA 03 01 XX 00
                const hexPacket = new Uint8Array([0x55, 0xAA, 0x03, 0x01, speed, 0x00]);
                return hexPacket;
            }
        }
        // 未来可以在这里添加更多协议...
        // "AnotherProtocol": { ... }
    };

    // --- 脚本核心逻辑 ---

    console.log('[Xtoys 玩具多多] 脚本已加载。正在等待拦截串口请求...');
    if (DEBUG_MODE) {
        console.warn('[Xtoys 玩具多多] 调试模式已启用。将不使用真实蓝牙设备。');
    }

    /**
     * @typedef {Object} BleConnectionState
     * @property {BluetoothDevice} device - 蓝牙设备对象
     * @property {BluetoothRemoteGATTServer} server - GATT 服务器对象
     * @property {BluetoothRemoteGATTCharacteristic} writeCharacteristic - 写入特性
     * @property {BluetoothRemoteGATTCharacteristic | null} notifyCharacteristic - 通知特性 (可能没有)
     * @property {Object} activeProtocol - 当前设备使用的协议配置
     * @property {MockSerialPort} mockPortInstance - 关联的模拟 SerialPort 实例
     * @property {string | null} deviceJsonId - XToys 为此设备提供的 'id' 字段 (如果有)。
     * @property {number} usbVendorId - 此设备的模拟 USB 供应商 ID。
     * @property {number} usbProductId - 此设备的模拟 USB 产品 ID。
     */
    const activeConnections = new Map(); // 使用 Map 存储，键可以是 device.id

    /**
     * 重置并移除某个设备的连接状态
     * @param {string} deviceId - 设备的ID
     */
    function removeConnectionState(deviceId) {
        if (activeConnections.has(deviceId)) {
            const state = activeConnections.get(deviceId);
            // 获取更友好的设备名称，用于日志
            const deviceFriendlyName = state.device.name || `ID: ${state.device.id}`;

            if (state.notifyCharacteristic) {
                try {
                    state.notifyCharacteristic.removeEventListener('characteristicvaluechanged', handleNotifications);
                    state.notifyCharacteristic.stopNotifications();
                } catch (e) {
                    // 优化：停止通知时，如果设备已断开，这是预期行为，降级为 debug 日志
                    console.debug(`[Xtoys 玩具多多] 停止设备 ${deviceFriendlyName} 的通知时出错 (通常是预期，设备可能已断开):`, e.message);
                }
            }
            if (state.device && state.device.gatt.connected) {
                state.device.gatt.disconnect();
            }

            // 同时从 activeCommandStreams Map 中移除 (如果存在)
            if (state.deviceJsonId && activeCommandStreams.has(state.deviceJsonId)) {
                activeCommandStreams.delete(state.deviceJsonId);
                console.log(`[Xtoys 玩具多多] 已移除 JSON ID 为 '${state.deviceJsonId}' 的命令流。`);
            } else if (activeCommandStreams.has(state.device.id)) { // 如果没有 JSON ID，则回退到设备 ID
                 activeCommandStreams.delete(state.device.id);
                 console.log(`[Xtoys 玩具多多] 已移除设备 ID 为 '${state.device.id}' 的命令流。`);
            }

            activeConnections.delete(deviceId);
            console.log(`[Xtoys 玩具多多] 已断开并移除设备 ${deviceFriendlyName} 的连接状态。当前活跃连接数: ${activeConnections.size}`);
        }
    }

    /**
     * 处理来自蓝牙设备的通知
     * @param {Event} event - 特性值改变事件
     */
    function handleNotifications(event) {
        const value = event.target.value;
        const characteristic = event.target;
        const service = characteristic.service;
        const deviceId = service.device.id;
        const deviceFriendlyName = activeConnections.get(deviceId)?.device.name || `ID: ${deviceId}`;
        console.debug(`[Xtoys 玩具多多] 收到来自设备 ${deviceFriendlyName} 的通知:`, value);
        // 在这里可以添加对通知数据的处理逻辑，例如推送到对应的 readable stream
        // 由于Xtoys主要使用 writable stream，此处暂时只做日志输出
    }

    /**
     * 伪造的 requestPort 函数，用于替代原始的 navigator.serial.requestPort
     * 每次调用都会尝试连接一个新设备
     */
    async function mockRequestPort() {
        console.info('[Xtoys 玩具多多] 已拦截 navigator.serial.requestPort() 调用。等待设备选择...');

        // 调试模式逻辑
        if (DEBUG_MODE) {
            // 在调试模式下，每次请求都创建一个新的模拟端口
            const defaultProtocolName = Object.keys(PROTOCOLS)[0];
            if (!defaultProtocolName) {
                const errMsg = "[Xtoys 玩具多多 调试模式] 未定义任何协议。无法在调试模式下运行。";
                console.error(errMsg);
                return Promise.reject(new Error(errMsg));
            }
            const activeProtocol = PROTOCOLS[defaultProtocolName];

            // 递增计数器，用于生成调试设备的唯一 ID
            debugDeviceCounter++;
            console.log(`[Xtoys 玩具多多 调试模式] debugDeviceCounter 当前值: ${debugDeviceCounter}`);

            // 为调试设备生成唯一的友好名称和模拟 USB ID
            const debugDeviceId = `debug-device-${Date.now()}-${debugDeviceCounter}`;
            const debugDeviceName = `调试设备 #${debugDeviceCounter}`;
            const mockUsbProductId = MOCK_USB_PRODUCT_ID_BASE + debugDeviceCounter; // 为每个调试设备生成唯一的 Product ID

            console.log(`[Xtoys 玩具多多 调试模式] 正在使用协议 "${defaultProtocolName}" 模拟设备 "${debugDeviceName}"。`);
            console.log(`[Xtoys 玩具多多 调试模式] 生成的设备ID: ${debugDeviceId}, 模拟 USB 产品ID: 0x${mockUsbProductId.toString(16)}`);

            const debugConnectionState = {
                device: { id: debugDeviceId, name: debugDeviceName }, // 模拟 device 对象，包含友好名称
                server: null,
                writeCharacteristic: null, // 在调试模式下不实际使用
                notifyCharacteristic: null, // 在调试模式下不实际使用
                activeProtocol: activeProtocol,
                mockPortInstance: null, // 将在 createMockSerialPort 中赋值
                deviceJsonId: null, // 调试设备初始没有 JSON 'id'
                usbVendorId: MOCK_USB_VENDOR_ID,
                usbProductId: mockUsbProductId
            };
            activeConnections.set(debugDeviceId, debugConnectionState);
            const mockPort = createMockSerialPort(debugConnectionState);
            debugConnectionState.mockPortInstance = mockPort;

            // 将此模拟端口的可写流添加到全局路由 Map 中，键为其内部 ID
            activeCommandStreams.set(debugDeviceId, mockPort.writable);
            console.log(`[Xtoys 玩具多多] 已将调试设备 '${debugDeviceId}' 添加到命令流 Map。`);

            return mockPort;
        }

        // 真实蓝牙设备连接逻辑
        let device;
        try {
            console.log('[Xtoys 玩具多多] 正在请求蓝牙设备，服务 UUIDs:', Object.values(PROTOCOLS).map(p => p.serviceUUID));
            device = await navigator.bluetooth.requestDevice({
                filters: Object.values(PROTOCOLS).map(p => ({ services: [p.serviceUUID] }))
            });
            const deviceFriendlyName = device.name || `ID: ${device.id}`;
            console.log('[Xtoys 玩具多多] 已选择设备:', deviceFriendlyName);

            // 检查该设备是否已连接，如果已连接则重用其模拟端口
            if (activeConnections.has(device.id) && activeConnections.get(device.id).device.gatt.connected) {
                console.log(`[Xtoys 玩具多多] 设备 ${deviceFriendlyName} 已连接。正在复用现有模拟端口。`);
                return activeConnections.get(device.id).mockPortInstance;
            }

            // 添加 GATT 断开连接事件监听器
            device.addEventListener('gattserverdisconnected', () => {
                console.warn(`[Xtoys 玩具多多] 蓝牙设备 ${deviceFriendlyName} 已断开连接。`);
                removeConnectionState(device.id); // 移除该设备的连接状态
            });

            console.log(`[Xtoys 玩具多多] 正在连接设备 ${deviceFriendlyName} 的 GATT 服务器...`);
            const server = await device.gatt.connect();

            let activeProtocol = null;
            let writeCharacteristic = null;
            let notifyCharacteristic = null;

            for (const protocolName in PROTOCOLS) {
                const protocol = PROTOCOLS[protocolName];
                try {
                    const service = await server.getPrimaryService(protocol.serviceUUID);
                    if (service) {
                        console.log(`[Xtoys 玩具多多] 在设备 ${deviceFriendlyName} 上找到匹配的协议服务: "${protocolName}"`);
                        activeProtocol = protocol;
                        writeCharacteristic = await service.getCharacteristic(protocol.writeUUID);
                        try {
                            notifyCharacteristic = await service.getCharacteristic(protocol.notifyUUID);
                            await notifyCharacteristic.startNotifications();
                            notifyCharacteristic.addEventListener('characteristicvaluechanged', handleNotifications);
                            console.log('[Xtoys 玩具多多] 已订阅通知。');
                        } catch (notifyError) {
                            console.warn('[Xtoys 玩具多多] 无法获取或订阅通知特性。', notifyError.message);
                        }
                        break; // 找到一个匹配的协议就停止
                    }
                } catch (serviceError) {
                    // console.debug(`[Xtoys 玩具多多] 在设备 ${deviceFriendlyName} 上未找到协议 "${protocolName}" 的服务。`, serviceError.message);
                    /* 忽略错误，继续尝试下一个协议 */
                }
            }

            if (!activeProtocol || !writeCharacteristic) {
                throw new Error(`在所选设备 ${deviceFriendlyName} 上找不到匹配的服务或写入特性。`);
            }

            // 为真实蓝牙设备生成一个唯一的模拟 USB 产品 ID
            // 使用 Date.now() 的一部分，以确保每次连接的 Product ID 都是不同的
            const mockUsbProductId = MOCK_USB_PRODUCT_ID_BASE + (Date.now() % 10000);

            // 存储新的连接状态
            const newConnectionState = {
                device: device,
                server: server,
                writeCharacteristic: writeCharacteristic,
                notifyCharacteristic: notifyCharacteristic,
                activeProtocol: activeProtocol,
                mockPortInstance: null, // 将在 createMockSerialPort 中赋值
                deviceJsonId: null, // 真实设备初始没有 JSON 'id'
                usbVendorId: MOCK_USB_VENDOR_ID,
                usbProductId: mockUsbProductId
            };
            activeConnections.set(device.id, newConnectionState); // 将新连接存储到 Map 中

            console.log(`[Xtoys 玩具多多] 设备 ${deviceFriendlyName} 蓝牙连接成功并准备就绪。模拟 USB 产品ID: 0x${mockUsbProductId.toString(16)}。当前活跃连接数: ${activeConnections.size}`);
            const mockPort = createMockSerialPort(newConnectionState);
            newConnectionState.mockPortInstance = mockPort; // 将模拟端口实例也保存到状态中

            // 将真实设备添加到命令流 Map 中，键为蓝牙设备 ID
            activeCommandStreams.set(device.id, mockPort.writable);
            console.log(`[Xtoys 玩具多多] 已将真实设备 '${device.id}' 添加到命令流 Map。`);

            return mockPort;

        } catch (error) {
            console.error('[Xtoys 玩具多多] 蓝牙连接失败:', error);
            // 如果连接失败，并且设备ID已经存在于 Map 中（可能是在选择设备后但在连接前失败），则将其移除
            if (device && activeConnections.has(device.id)) {
                removeConnectionState(device.id);
            }
            return Promise.reject(error);
        }
    }

    /**
     * 创建一个模拟的 SerialPort 对象，并将其绑定到特定的连接状态
     * @param {BleConnectionState} connectionState - 当前设备的连接状态
     * @returns {object} 一个包含可写流的模拟 Port 对象
     */
    function createMockSerialPort(connectionState) {
        // 获取更友好的设备名称，用于日志和 getInfo().deviceName
        // 优先使用 XToys JSON ID，然后是连接状态中的设备名称，最后是通用的蓝牙 ID 字符串
        const deviceFriendlyName = connectionState.deviceJsonId || connectionState.device.name || `蓝牙设备 ${connectionState.device.id.substring(0, 8)}`;

        const mockPort = {
            // 这个可写流将作为所有来自 XToys 的传入命令的路由器
            writable: new WritableStream({
                async write(chunk) {
                    try {
                        const commandStr = new TextDecoder().decode(chunk);
                        const command = JSON.parse(commandStr);
                        console.debug(`[Xtoys 玩具多多] 收到原始命令 (来自 ${deviceFriendlyName}):`, command);

                        // 根据命令中的 'id' 字段确定目标设备 ID，
                        // 如果没有 'id'，则默认为当前连接的设备 ID。
                        const targetJsonId = command.id;
                        let targetDeviceId = connectionState.device.id; // 默认为当前端口的设备 ID

                        // 如果 JSON 命令中存在 'id'，则使用它来查找 *实际* 目标连接。
                        // 如果是调试设备，且 XToys 提供了 'id'，则更新此 mockPort 的 connectionState。
                        if (targetJsonId) {
                            // 首先，尝试查找已注册此 JSON ID 的连接。
                            let foundConnection = null;
                            for (const conn of activeConnections.values()) {
                                // 检查此连接的内部设备 ID 或其存储的 JSON ID 是否匹配
                                if (conn.device.id === targetJsonId || conn.deviceJsonId === targetJsonId) {
                                    foundConnection = conn;
                                    break;
                                }
                            }

                            // 如果未找到，且这是调试连接，则假定此 JSON ID 适用于 *此* 调试设备。
                            if (!foundConnection && connectionState.device.id.startsWith('debug-device-')) {
                                // 对于调试设备，如果它们发送 'id'，我们将其注册。
                                connectionState.deviceJsonId = targetJsonId;
                                console.log(`[Xtoys 玩具多多] 调试设备 '${connectionState.device.name}' 现在映射到 JSON ID '${targetJsonId}'。`);
                                // targetDeviceId 保持 connectionState.device.id，这是正确的
                            } else if (foundConnection) {
                                // 找到了匹配 targetJsonId 的连接，使用其内部设备 ID 进行查找
                                targetDeviceId = foundConnection.device.id;
                            } else {
                                // 如果 targetJsonId 存在但与任何已知内部 ID 或 JSON ID 不匹配，
                                // 则回退到使用 targetJsonId 作为 targetDeviceId，但这可能导致“未找到”的情况
                                console.debug(`[Xtoys 玩具多多] 命令包含 JSON ID '${targetJsonId}'。未直接找到匹配的活跃连接。回退到将 JSON ID 用作目标。`);
                                targetDeviceId = targetJsonId; // 尝试使用 JSON ID 作为直接查找键
                            }
                        }

                        // 检索确定目标设备的特定连接状态
                        const targetConnectionState = activeConnections.get(targetDeviceId);

                        if (!targetConnectionState) {
                            console.warn(`[Xtoys 玩具多多] 未找到内部 ID 为 '${targetDeviceId}' 的活跃连接 (来自 JSON ID: ${targetJsonId || 'N/A'})。命令已跳过。`, command);
                            return; // 如果没有目标连接，则跳过
                        }

                        // 使用目标设备的协议转换命令
                        const dataPacket = targetConnectionState.activeProtocol.transform(command);

                        if (dataPacket) {
                            const hexString = `[${Array.from(dataPacket).map(b => b.toString(16).padStart(2, '0')).join(' ')}]`;

                            if (DEBUG_MODE) {
                                // 使用最合适的名称进行调试日志
                                const logDeviceName = targetConnectionState.deviceJsonId || targetConnectionState.device.name || targetConnectionState.device.id;
                                console.log(`[Xtoys 玩具多多 调试模式] 正在路由到设备 '${logDeviceName}' (JSON ID: ${targetJsonId || 'N/A'})。发送 HEX 数据: ${hexString}`);
                            } else {
                                if (!targetConnectionState.writeCharacteristic) {
                                    console.error(`[Xtoys 玩具多多] 设备 '${targetConnectionState.device.name || targetConnectionState.device.id}' 写入失败: 此端口的蓝牙特性不可用。`);
                                    throw new Error("此端口的蓝牙特性不可用。");
                                }
                                const logDeviceName = targetConnectionState.deviceJsonId || targetConnectionState.device.name || targetConnectionState.device.id;
                                console.debug(`[Xtoys 玩具多多] 正在路由到设备 '${logDeviceName}' (JSON ID: ${targetJsonId || 'N/A'})。已转换为 HEX ${hexString} 并发送到蓝牙设备...`);
                                await targetConnectionState.writeCharacteristic.writeValueWithoutResponse(dataPacket);
                            }
                        } else {
                            console.warn(`[Xtoys 玩具多多] 设备 '${targetConnectionState.device.name || targetConnectionState.device.id}' 未生成数据包，跳过写入操作。`);
                        }
                    } catch (error) {
                        console.error(`[Xtoys 玩具多多] 设备 ${deviceFriendlyName} 处理和写入数据失败:`, error);
                        // 如果是 JSON 解析错误，则特别记录
                        if (error instanceof SyntaxError && error.message.includes("JSON.parse")) {
                            console.error(`[Xtoys 玩具多多] 可能收到非 JSON 数据: ${new TextDecoder().decode(chunk).substring(0, 100)}...`);
                        }
                        throw error;
                    }
                },
                close() {
                    console.log(`[Xtoys 玩具多多] 设备 ${deviceFriendlyName} 的可写流已关闭。`);
                    if (!DEBUG_MODE && connectionState.device && connectionState.device.gatt.connected) {
                        removeConnectionState(connectionState.device.id); // 通过 ID 移除连接
                    }
                },
                abort(err) {
                    console.error(`[Xtoys 玩具多多] 设备 ${deviceFriendlyName} 的可写流已中止:`, err);
                    if (!DEBUG_MODE && connectionState.device && connectionState.device.gatt.connected) {
                        removeConnectionState(connectionState.device.id); // 通过 ID 移除连接
                    }
                }
            }),
            readable: new ReadableStream({
                start(controller) { console.log(`[Xtoys 玩具多多] 设备 ${deviceFriendlyName} 的模拟可读流已启动。`); }
                // TODO: 如果需要从蓝牙设备接收数据并推送到 ReadableStream，需要在这里实现
                // 例如：在 handleNotifications 中将数据 enqueue 到 controller
            }),
            getInfo() {
                // 返回与此端口关联的设备信息
                return {
                    usbVendorId: connectionState.usbVendorId,
                    usbProductId: connectionState.usbProductId,
                    bluetoothServiceClassId: connectionState.activeProtocol?.serviceUUID || '',
                    deviceId: connectionState.device.id,
                    // 优先使用 XToys JSON ID 作为显示名称，然后是内部设备名称，最后是通用蓝牙 ID
                    deviceName: connectionState.deviceJsonId || connectionState.device.name || `蓝牙设备 ${connectionState.device.id.substring(0, 8)}`
                };
            },
            async open(options) {
                console.log(`[Xtoys 玩具多多] 设备 ${deviceFriendlyName} 的模拟端口已使用选项打开:`, options);
                return Promise.resolve();
            },
            async close() {
                console.log(`[Xtoys 玩具多多] 设备 ${deviceFriendlyName} 的模拟端口 close() 方法被调用。`);
                try {
                    if (this.writable && !this.writable.locked) {
                        await this.writable.close();
                    }
                } catch (e) {
                    // 优化：处理预期的 'Cannot close a ERRORED writable stream' 错误
                    if (e.message.includes("Cannot close a ERRORED writable stream")) {
                        console.debug(`[Xtoys 玩具多多] 关闭设备 ${deviceFriendlyName} 的可写流时出错 (预期的错误，流可能已中止):`, e.message);
                    } else {
                        // 对于其他非预期错误，仍然作为警告或错误处理
                        console.warn(`[Xtoys 玩具多多] 关闭设备 ${deviceFriendlyName} 的可写流时出错:`, e.message);
                    }
                }
            },
            setSignals: async () => {},
            getSignals: async () => ({}),
            forget: async () => {
                console.log(`[Xtoys 玩具多多] 设备 ${deviceFriendlyName} 的 forget 方法被调用。正在断开连接。`);
                await mockPort.close(); // 调用模拟端口的 close 方法来断开连接并清理状态
            }
        };

        console.log(`[Xtoys 玩具多多] 已为设备 ${deviceFriendlyName} 创建模拟 SerialPort 对象。`, mockPort);
        return mockPort;
    }

    // --- 最终覆盖 ---
    if (unsafeWindow.navigator.serial) {
        unsafeWindow.navigator.serial.requestPort = mockRequestPort;
        // 覆盖 getPorts 以返回所有当前活跃的模拟端口
        unsafeWindow.navigator.serial.getPorts = async () => {
            return Array.from(activeConnections.values()).map(conn => conn.mockPortInstance).filter(Boolean);
        };
        console.info('[Xtoys 玩具多多] 已成功拦截 navigator.serial.requestPort 和 getPorts。');
    } else {
        // 如果 navigator.serial 不存在，则创建完整的模拟 API
        Object.defineProperty(unsafeWindow.navigator, 'serial', {
            value: {
                requestPort: mockRequestPort,
                getPorts: async () => {
                    return Array.from(activeConnections.values()).map(conn => conn.mockPortInstance).filter(Boolean);
                }
            },
            writable: true
        });
        console.info('[Xtoys 玩具多多] 未找到 navigator.serial，已创建模拟 API。');
    }

})();
