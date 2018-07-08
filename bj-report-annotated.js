
var BJ_REPORT = (function(global) {
    if (global.BJ_REPORT) return global.BJ_REPORT;

    var _log_list = [];
    var _log_map = {};
    var _config = {
        id: 0, // 上报 id
        uin: 0, // user id
        url: "", // 上报 接口
        offline_url: "", // 离线日志上报 接口
        offline_auto_url: "", // 检测是否自动上报
        ext: null, // 扩展参数 用于自定义上报
        level: 4, // 错误级别 1-debug 2-info 4-error
        ignore: [], // 忽略某个错误, 支持 Regexp 和 Function
        random: 1, // 抽样 (0-1] 1-全量
        delay: 1000, // 延迟上报 combo 为 true 时有效
        submit: null, // 自定义上报方式
        repeat: 5, // 重复上报次数(对于同一个错误超过多少次不上报),
        offlineLog: false, //是否启用离线日志
        offlineLogExp: 5,  // 离线日志过期时间 ， 默认5天
        offlineLogAuto: false,  //是否自动询问服务器需要自动上报
    };

    var Offline_DB = {
        db: null,
        // 初始化数据库
        ready: function(callback) {
            var self = this;
            // 如果indexedDB数据库在该环境不兼容
            if (!window.indexedDB || !_config.offlineLog) {
                _config.offlineLog = false;
                return callback();
            }
            // 已经初始化过
            if (this.db) {
                setTimeout(function() {
                    callback(null, self);
                }, 0);

                return;
            }
            var version = 1;
            // 打开数据库
            var request = window.indexedDB.open("badjs", version);

            if (!request) {
                _config.offlineLog = false;
                return callback();
            }

            request.onerror = function(e) {
                callback(e);
                _config.offlineLog = false;
                console.log("indexdb request error");
                return true;
            };
            // 打开成功
            request.onsuccess = function(e) {
                self.db = e.target.result;
                // 打开成功后执行回调
                setTimeout(function() {
                    callback(null, self);
                }, 500);


            };
            // 版本升级（初始化时会先触发upgradeneeded，再触发success）
            request.onupgradeneeded = function(e) {
                var db = e.target.result;
                if (!db.objectStoreNames.contains('logs')) {
                    db.createObjectStore('logs', { autoIncrement: true });
                }
            };
        },
        insertToDB: function(log) {
            var store = this.getStore();
            store.add(log);
        },
        addLog: function(log) {
            if (!this.db) {
                return;
            }
            this.insertToDB(log);
        },
        addLogs: function(logs) {
            if (!this.db) {
                return;
            }
            // 遍历插入
            for (var i = 0; i < logs.length; i++) {
                this.addLog(logs[i]);
            }

        },
        // 通过cursor指针遍历数据库
        getLogs: function(opt, callback) {
            if (!this.db) {
                return;
            }
            var store = this.getStore();
            // 创建一个读取光标
            var request = store.openCursor();
            var result = [];
            request.onsuccess = function(event) {
                var cursor = event.target.result;
                if (cursor) {
                    // 满足opt对象要求的才能推入result数组回传
                    if (cursor.value.time >= opt.start && cursor.value.time <= opt.end && cursor.value.id == opt.id && cursor.value.uin == opt.uin) {
                        result.push(cursor.value);
                    }
                    // 读取下一个
                    cursor["continue"]();
                } else {
                    // 遍历完毕，执行回调
                    callback(null, result);
                }
            };

            request.onerror = function(e) {
                callback(e);
                return true;
            };
        },
        // 清除过期的离线日志
        clearDB: function(daysToMaintain) {
            if (!this.db) {
                return;
            }

            var store = this.getStore();
            // 参数不存在则清除所有日志
            if (!daysToMaintain) {
                store.clear();
                return;
            }
            // 计算过期时间
            var range = (Date.now() - (daysToMaintain || 2) * 24 * 3600 * 1000);
            var request = store.openCursor();
            request.onsuccess = function(event) {
                var cursor = event.target.result;
                if (cursor && (cursor.value.time < range || !cursor.value.time)) {
                    // 删除过期日志
                    store["delete"](cursor.primaryKey);
                    cursor["continue"]();
                }
            };
        },

        getStore: function() {
            // 打开logs数据库
            var transaction = this.db.transaction("logs", 'readwrite');
            return transaction.objectStore("logs");
        },

    };

    var T = {
        isOBJByType: function(o, type) {
            return Object.prototype.toString.call(o) === "[object " + (type || "Object") + "]";
        },

        isOBJ: function(obj) {
            var type = typeof obj;
            return type === "object" && !!obj;
        },
        isEmpty: function(obj) {
            if (obj === null) return true;
            if (T.isOBJByType(obj, "Number")) {
                return false;
            }
            return !obj;
        },
        extend: function(src, source) {
            for (var key in source) {
                src[key] = source[key];
            }
            return src;
        },
        // 格式化错误信息
        processError: function(errObj) {
            try {
                if (errObj.stack) {
                    var url = errObj.stack.match("https?://[^\n]+");
                    url = url ? url[0] : "";
                    var rowCols = url.match(":(\\d+):(\\d+)");
                    if (!rowCols) {
                        rowCols = [0, 0, 0];
                    }

                    var stack = T.processStackMsg(errObj);
                    return {
                        msg: stack,
                        rowNum: rowCols[1],
                        colNum: rowCols[2],
                        target: url.replace(rowCols[0], ""),
                        _orgMsg: errObj.toString()
                    };
                } else {
                    //ie 独有 error 对象信息，try-catch 捕获到错误信息传过来，造成没有msg
                    if (errObj.name && errObj.message && errObj.description) {
                        return {
                            msg: JSON.stringify(errObj)
                        };
                    }
                    return errObj;
                }
            } catch (err) {
                return errObj;
            }
        },
        // 进行格式转换
        processStackMsg: function(error) {
            var stack = error.stack
                .replace(/\n/gi, "")
                .split(/\bat\b/)
                .slice(0, 9)
                .join("@")
                .replace(/\?[^:]+/gi, "");
            var msg = error.toString();
            if (stack.indexOf(msg) < 0) {
                stack = msg + "@" + stack;
            }
            return stack;
        },
        // 判断是否超过重复上报次数
        isRepeat: function(error) {
            if (!T.isOBJ(error)) return true;
            var msg = error.msg;
            var times = _log_map[msg] = (parseInt(_log_map[msg], 10) || 0) + 1;
            return times > _config.repeat;
        }
    };
    // 保存原有的全局onerror事件
    var orgError = global.onerror;
    // 重写onerror事件
    global.onerror = function(msg, url, line, col, error) {
        var newMsg = msg;

        if (error && error.stack) {
            newMsg = T.processStackMsg(error);
        }
        if (T.isOBJByType(newMsg, "Event")) {
            newMsg += newMsg.type ?
                ("--" + newMsg.type + "--" + (newMsg.target ?
                    (newMsg.target.tagName + "::" + newMsg.target.src) : "")) : "";
        }
        // 将错误信息对象推入错误队列中，执行_process_log方法进行上报
        report.push({
            msg: newMsg,
            target: url,
            rowNum: line,
            colNum: col,
            _orgMsg: msg
        });

        _process_log();
        // 调用原有的全局onerror事件
        orgError && orgError.apply(global, arguments);
    };


    // 格式化log信息
    var _report_log_tostring = function(error, index) {
        var param = [];
        var params = [];
        var stringify = [];
        if (T.isOBJ(error)) {
            error.level = error.level || _config.level;
            for (var key in error) {
                var value = error[key];
                if (!T.isEmpty(value)) {
                    if (T.isOBJ(value)) {
                        try {
                            value = JSON.stringify(value);
                        } catch (err) {
                            value = "[BJ_REPORT detect value stringify error] " + err.toString();
                        }
                    }
                    stringify.push(key + ":" + value);
                    param.push(key + "=" + encodeURIComponent(value));
                    params.push(key + "[" + index + "]=" + encodeURIComponent(value));
                }
            }
        }

        // msg[0]=msg&target[0]=target -- combo report
        // msg:msg,target:target -- ignore
        // msg=msg&target=target -- report with out combo
        return [params.join("&"), stringify.join(","), param.join("&")];
    };



    var _offline_buffer = [];
    var _save2Offline = function(key, msgObj) {
        // 给msgObj添加额外信息
        msgObj = T.extend({ id: _config.id, uin: _config.uin, time: new Date - 0 }, msgObj);
        // 若数据库已初始化则直接推入
        if (Offline_DB.db) {
            Offline_DB.addLog(msgObj);
            return;
        }
        // 否则初始化后再推入
        if (!Offline_DB.db && !_offline_buffer.length) {
            Offline_DB.ready(function(err, DB) {
                if (DB) {
                    if (_offline_buffer.length) {
                        DB.addLogs(_offline_buffer);
                        _offline_buffer = [];
                    }

                }
            });
        }
        _offline_buffer.push(msgObj);
    };
    // 使用添加script的方式上报离线日志
    var _autoReportOffline = function() {
        var script = document.createElement("script");
        script.src = _config.offline_auto_url || _config.url.replace(/badjs$/, "offlineAuto") + "?id=" + _config.id + "&uin=" + _config.uin;
        // 将主动上报函数reportOfflineLog上升为全局函数方法_badjsOfflineAuto
        window._badjsOfflineAuto = function(isReport) {
            if (isReport) {
                BJ_REPORT.reportOfflineLog();
            }
        };
        document.head.appendChild(script);
    };



    var submit_log_list = [];
    var comboTimeout = 0;
    var _submit_log = function() {
        // 清除之前的延迟上报计时器
        clearTimeout(comboTimeout);
        // https://github.com/BetterJS/badjs-report/issues/34
        comboTimeout = 0;

        if (!submit_log_list.length) {
            return;
        }

        var url = _config._reportUrl + submit_log_list.join("&") + "&count=" + submit_log_list.length + "&_t=" + (+new Date);
        // 若用户自定义了上报方法，则使用自定义方法
        if (_config.submit) {
            _config.submit(url, submit_log_list);
        } else {
            // 否则使用img标签上报
            var _img = new Image();
            _img.src = url;
        }

        submit_log_list = [];
    };

    var _process_log = function(isReportNow) {
        if (!_config._reportUrl) return;
        // 取随机数，来决定是否忽略该次上报
        var randomIgnore = Math.random() >= _config.random;

        while (_log_list.length) {
            var isIgnore = false;
            // 循环遍历
            var report_log = _log_list.shift();
            // 有效保证字符不要过长
            report_log.msg = (report_log.msg + "" || "").substr(0, 500);
            // 重复上报
            if (T.isRepeat(report_log)) continue;
            // 格式化log信息
            var log_str = _report_log_tostring(report_log, submit_log_list.length);
            // 若用户自定义了ignore规则，则按照规则进行筛选
            if (T.isOBJByType(_config.ignore, "Array")) {
                for (var i = 0, l = _config.ignore.length; i < l; i++) {
                    var rule = _config.ignore[i];
                    if ((T.isOBJByType(rule, "RegExp") && rule.test(log_str[1])) ||
                        (T.isOBJByType(rule, "Function") && rule(report_log, log_str[1]))) {
                        isIgnore = true;
                        break;
                    }
                }
            }
            // 通过了ignore规则
            if (!isIgnore) {
                // 若离线日志功能已开启，则将日志存入数据库
                _config.offlineLog && _save2Offline("badjs_" + _config.id + _config.uin, report_log);
                // level为20表示是offlineLog方法push进来的，只存入离线日志而不上报
                if (!randomIgnore && report_log.level != 20) {
                    // 若可以上报，则推入submit_log_list，稍后由_submit_log方法来清空该队列并上报
                    submit_log_list.push(log_str[0]);
                    // 执行上报回调函数
                    _config.onReport && (_config.onReport(_config.id, report_log));
                }

            }
        }


        if (isReportNow) {
            _submit_log(); // 立即上报
        } else if (!comboTimeout) {
            comboTimeout = setTimeout(_submit_log, _config.delay); // 延迟上报
        }
    };



    var report = global.BJ_REPORT = {
        push: function(msg) { // 将错误推到缓存池
            var data = T.isOBJ(msg) ? T.processError(msg) : {
                msg: msg
            };
            // ext 有默认值, 且上报不包含 ext, 使用默认 ext
            if (_config.ext && !data.ext) {
                data.ext = _config.ext;
            }
            // 在错误发生时获取页面链接
            // https://github.com/BetterJS/badjs-report/issues/19
            if (!data.from) {
                data.from = location.href;
            }

            if (data._orgMsg) {
                var _orgMsg = data._orgMsg;
                delete data._orgMsg;
                data.level = 2;
                var newData = T.extend({}, data);
                newData.level = 4;
                newData.msg = _orgMsg;
                _log_list.push(data);
                _log_list.push(newData);
            } else {
                _log_list.push(data);
            }
            _process_log();
            return report;
        },
        // 主动进行上报
        report: function(msg, isReportNow) {
            msg && report.push(msg);

            isReportNow && _process_log(true);
            return report;
        },
        // 主动上报info级别信息
        info: function(msg) { // info report
            if (!msg) {
                return report;
            }
            if (T.isOBJ(msg)) {
                msg.level = 2;
            } else {
                msg = {
                    msg: msg,
                    level: 2
                };
            }
            report.push(msg);
            return report;
        },
        // 主动上报debug级别信息
        debug: function(msg) { // debug report
            if (!msg) {
                return report;
            }
            if (T.isOBJ(msg)) {
                msg.level = 1;
            } else {
                msg = {
                    msg: msg,
                    level: 1
                };
            }
            report.push(msg);
            return report;
        },
        // 主动上报离线日志
        reportOfflineLog: function() {
            if (!window.indexedDB) {
                BJ_REPORT.info("unsupport offlineLog");
                return;
            }
            Offline_DB.ready(function(err, DB) {
                if (!DB) { 
                    return;
                }
                // 日期要求是startDate ~ endDate
                var startDate = new Date - 0 - _config.offlineLogExp * 24 * 3600 * 1000;
                var endDate = new Date - 0;
                DB.getLogs({
                    start: startDate,
                    end: endDate,
                    id: _config.id,
                    uin: _config.uin
                }, function(err, result) {
                    var iframe = document.createElement("iframe");
                    iframe.name = "badjs_offline_" + (new Date - 0);
                    iframe.frameborder = 0;
                    iframe.height = 0;
                    iframe.width = 0;
                    iframe.src = "javascript:false;";

                    iframe.onload = function() {
                        var form = document.createElement("form");
                        form.style.display = "none";
                        form.target = iframe.name;
                        form.method = "POST";
                        form.action = _config.offline_url || _config.url.replace(/badjs$/, "offlineLog");
                        form.enctype.method = 'multipart/form-data';

                        var input = document.createElement("input");
                        input.style.display = "none";
                        input.type = "hidden";
                        input.name = "offline_log";
                        input.value = JSON.stringify({ logs: result, userAgent: navigator.userAgent, startDate: startDate, endDate: endDate, id: _config.id, uin: _config.uin });
                        iframe.contentDocument.body.appendChild(form);
                        form.appendChild(input);
                        // 通过form表单提交来上报离线日志
                        form.submit();

                        setTimeout(function() {
                            document.body.removeChild(iframe);
                        }, 10000);

                        iframe.onload = null;
                    };
                    document.body.appendChild(iframe);
                });
            });
        },
        // 记录离线日志，即只存入离线日志而不通过_process_log上报
        offlineLog: function(msg) {
            if (!msg) {
                return report;
            }
            if (T.isOBJ(msg)) {
                msg.level = 20;
            } else {
                msg = {
                    msg: msg,
                    level: 20
                };
            }
            report.push(msg);
            return report;
        },
        init: function(config) { // 初始化
            // 用配置参数的值覆盖_config的默认值
            if (T.isOBJ(config)) {
                for (var key in config) {
                    _config[key] = config[key];
                }
            }
            // 没有设置id将不上报
            var id = parseInt(_config.id, 10);
            if (id) {
                // set default report url and uin
                if (/qq\.com$/gi.test(location.hostname)) {
                    if (!_config.url) {
                        _config.url = "//badjs2.qq.com/badjs";
                    }

                    if (!_config.uin) {
                        _config.uin = parseInt((document.cookie.match(/\buin=\D+(\d+)/) || [])[1], 10);
                    }
                }

                _config._reportUrl = (_config.url || "/badjs") +
                    "?id=" + id +
                    "&uin=" + _config.uin +
                    // "&from=" + encodeURIComponent(location.href) +
                    "&";
            }

            // if had error in cache , report now
            if (_log_list.length) {
                _process_log();
            }

            // init offlineDB
            if (!Offline_DB._initing) {
                Offline_DB._initing = true;
                Offline_DB.ready(function(err, DB) {
                    if (DB) {
                        setTimeout(function() {
                            // 清除过期日志
                            DB.clearDB(_config.offlineLogExp);
                            setTimeout(function() {
                                _config.offlineLogAuto && _autoReportOffline();
                            }, 5000);
                        }, 1000);
                    }

                });
            }



            return report;
        },

        __onerror__: global.onerror
    };

    typeof console !== "undefined" && console.error && setTimeout(function() {
        var err = ((location.hash || "").match(/([#&])BJ_ERROR=([^&$]+)/) || [])[2];
        err && console.error("BJ_ERROR", decodeURIComponent(err).replace(/(:\d+:\d+)\s*/g, "$1\n"));
    }, 0);

    return report;

}(window));

if (typeof module !== "undefined") {
    module.exports = BJ_REPORT;
}
