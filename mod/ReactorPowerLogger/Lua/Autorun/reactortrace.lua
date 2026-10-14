-- Reactor Trace (client-side LuaCs): records the main reactor's FULL internal state 10 times a second, including
-- private fields (timers, skill factor, optimal ranges), plus events (rods added/removed, AutoTemp/power toggled,
-- fire started, meltdown). Purpose: ground truth for checking the simulator against the real game,
-- e.g. "put 4 fuel rods in a 5200 kW reactor on automatic and watch what happens".
-- Output: LocalMods/ReactorPowerLogger/Logs/<sub>_roundNNN_reactor.csv  ->  node sim/cli.js verify <file>
-- Console: "reactortrace" toggles it (on by default).
if SERVER then return end

local modPath = ...
local TR = { interval = 6, flushInterval = 30, enabled = true }   -- interval in ticks (6 = 10 per second)

-- make the private Reactor fields readable
local PRIVATE = { "degreeOfSuccess", "meltDownTimer", "fireTimer", "prevAvailableFuel", "temperatureBoost",
    "optimalTemperature", "allowedTemperature", "optimalFissionRate", "allowedFissionRate", "optimalTurbineOutput", "allowedTurbineOutput",
    "signalControlledTargetFissionRate", "signalControlledTargetTurbineOutput", "minUpdatePowerOut", "maxUpdatePowerOut" }
pcall(function()
    local d = LuaUserData.RegisterType("Barotrauma.Items.Components.Reactor")
    for _, f in ipairs(PRIVATE) do pcall(function() LuaUserData.MakeFieldAccessible(d, f) end) end
end)

local COLS = { "t", "temp", "fission", "turbine", "target_fission", "target_turbine", "correct_turbine", "load", "output", "max_kw",
    "avail_fuel", "rods", "rod_cond", "autotemp", "power_on", "condition", "meltdown_timer", "fire_timer", "dos",
    "opt_temp_lo", "opt_temp_hi", "allowed_temp_hi", "opt_turb_lo", "opt_turb_hi", "opt_fission_lo", "opt_fission_hi",
    "sig_fission", "sig_turbine", "last_user_player", "voltage", "event" }

local active, rows, tick, roundTime, lastReal, nextFlush, filePath, reactor, prev
local firstError = nil
local function log(m) print("[ReactorTrace] " .. m) end
local function noteError(where, err)
    if firstError == nil then firstError = where .. ": " .. tostring(err); log("first error (please report): " .. firstError) end
end

-- every read is protected: a value the game won't give us becomes an empty cell instead of losing the whole row
local function num(x, fmt)
    local n = tonumber(x)
    if n == nil then return "" end
    return string.format(fmt or "%.3f", n)
end
local function get(obj, field)
    local ok, v = pcall(function() return obj[field] end)
    if ok then return v end
    noteError("read " .. field, v)
    return nil
end
local function vx(v) if v == nil then return nil end local ok, r = pcall(function() return v.X end); return ok and r or nil end
local function vy(v) if v == nil then return nil end local ok, r = pcall(function() return v.Y end); return ok and r or nil end
local function opt(v) -- float? (Nullable) -> number or nil
    if v == nil then return nil end
    local ok, r = pcall(function() return tonumber(tostring(v)) end); return ok and r or nil
end

local function findReactor()
    for item in Item.ItemList do
        if item.Submarine == Submarine.MainSub then
            local r = item.GetComponentString("Reactor")
            if r ~= nil then return r end
        end
    end
    return nil
end

local function rodsInfo(r)
    local n, conds = 0, {}
    pcall(function()
        for rod in r.Item.OwnInventory.AllItems do
            n = n + 1
            table.insert(conds, tostring(rod.Prefab.Identifier) .. ":" .. string.format("%.1f", rod.Condition))
        end
    end)
    return n, table.concat(conds, " ")
end

local function voltage(r)
    local v = nil
    pcall(function()
        for c in r.Item.Connections do
            if c.IsPower and c.IsOutput and c.Grid ~= nil then v = c.Grid.Voltage end
        end
    end)
    return v
end

local function snapshot(r)
    local n, conds = rodsInfo(r)
    local lu = get(r, "LastUser")
    local isPlayer = 0
    pcall(function() if lu ~= nil and lu.IsPlayer then isPlayer = 1 end end)
    local cpc = tonumber(get(r, "CurrPowerConsumption"))
    local item = get(r, "Item")
    local s = {
        t = roundTime, temp = get(r, "Temperature"), fission = get(r, "FissionRate"), turbine = get(r, "TurbineOutput"),
        target_fission = get(r, "TargetFissionRate"), target_turbine = get(r, "TargetTurbineOutput"), correct_turbine = get(r, "CorrectTurbineOutput"),
        load = get(r, "Load"), output = cpc and -cpc or nil, max_kw = get(r, "MaxPowerOutput"),
        avail_fuel = get(r, "prevAvailableFuel"), rods = n, rod_cond = conds,
        autotemp = get(r, "AutoTemp") and 1 or 0, power_on = get(r, "PowerOn") and 1 or 0, condition = item and get(item, "ConditionPercentage") or nil,
        meltdown_timer = get(r, "meltDownTimer"), fire_timer = get(r, "fireTimer"), dos = get(r, "degreeOfSuccess"),
        opt_temp_lo = vx(get(r, "optimalTemperature")), opt_temp_hi = vy(get(r, "optimalTemperature")), allowed_temp_hi = vy(get(r, "allowedTemperature")),
        opt_turb_lo = vx(get(r, "optimalTurbineOutput")), opt_turb_hi = vy(get(r, "optimalTurbineOutput")),
        opt_fission_lo = vx(get(r, "optimalFissionRate")), opt_fission_hi = vy(get(r, "optimalFissionRate")),
        sig_fission = opt(get(r, "signalControlledTargetFissionRate")), sig_turbine = opt(get(r, "signalControlledTargetTurbineOutput")),
        last_user_player = isPlayer, voltage = voltage(r),
    }
    return s
end

local function events(s)
    local e = {}
    local ok = pcall(function()
    if prev ~= nil and tonumber(s.temp) and tonumber(prev.temp) then
        if s.rods ~= prev.rods then table.insert(e, "rods " .. prev.rods .. "->" .. s.rods) end
        if s.autotemp ~= prev.autotemp then table.insert(e, s.autotemp == 1 and "autotemp on" or "autotemp off") end
        if s.power_on ~= prev.power_on then table.insert(e, s.power_on == 1 and "power on" or "power off") end
        if s.fire_timer ~= nil and prev.fire_timer ~= nil and prev.fire_timer > 1 and s.fire_timer < prev.fire_timer - 1 then table.insert(e, "FIRE started") end
        if tonumber(s.condition) and tonumber(prev.condition) and s.condition <= 0 and prev.condition > 0 then table.insert(e, "MELTDOWN") end
        if s.temp > 70 and prev.temp <= 70 then table.insert(e, "temp > 70 (meltdown timer running)") end
    end
    end)
    return table.concat(e, "; ")
end

local function row(s)
    local out = {}
    for _, c in ipairs(COLS) do
        local v = s[c]
        if c == "rod_cond" or c == "event" then out[#out + 1] = tostring(v or ""):gsub(",", ";")
        elseif c == "rods" or c == "autotemp" or c == "power_on" or c == "last_user_player" then out[#out + 1] = v == nil and "" or tostring(v)
        else out[#out + 1] = num(v) end
    end
    return table.concat(out, ",")
end

local function flush()
    if not active or filePath == nil then return end
    local note = firstError and ("# first error: " .. tostring(firstError):gsub("[\r\n]", " ") .. "\n") or ""
    local ok, err = pcall(function() File.Write(filePath, "# ReactorTrace v1\n# sub=" .. tostring(Submarine.MainSub.Info.Name) .. "\n" .. note .. table.concat(COLS, ",") .. "\n" .. table.concat(rows, "\n") .. "\n") end)
    if not ok then log("write failed: " .. tostring(err)) end
end

local function start()
    if not TR.enabled then return end
    reactor = findReactor()
    if reactor == nil then log("no reactor on the main sub"); return end
    local base = (type(modPath) == "string" and modPath ~= "") and modPath or "LocalMods/ReactorPowerLogger"
    local dir = base .. "/Logs"
    pcall(function() if not File.DirectoryExists(dir) then File.CreateDirectory(dir) end end)
    local safe = tostring(Submarine.MainSub.Info.Name):gsub("[^%w_%-]", "_")
    local n = 1
    while File.Exists(string.format("%s/%s_round%03d_reactor.csv", dir, safe, n)) do n = n + 1 end
    filePath = string.format("%s/%s_round%03d_reactor.csv", dir, safe, n)
    rows, tick, roundTime, lastReal, nextFlush, prev = {}, 0, 0, Timer.GetTime(), TR.flushInterval, nil
    active = true
    log("tracing reactor -> " .. filePath)
end

local function stop()
    if not active then return end
    flush(); active = false
    log("saved " .. #rows .. " rows to " .. tostring(filePath))
end

Hook.Add("roundStart", "ReactorTrace.start", start)
Hook.Add("roundEnd", "ReactorTrace.stop", stop)
Hook.Add("think", "ReactorTrace.think", function()
    if not active then return end
    local now = Timer.GetTime(); local dt = now - lastReal; lastReal = now
    if Game.Paused or dt <= 0 then return end
    roundTime = roundTime + math.min(dt, 0.1)
    tick = tick + 1
    local ok, s = pcall(snapshot, reactor)
    if not ok then noteError("snapshot", s); return end
    s.event = events(s)
    if tick % TR.interval == 0 or s.event ~= "" then
        local ok2, line = pcall(row, s)
        if ok2 then rows[#rows + 1] = line else noteError("row", line) end
    end
    prev = s
    if roundTime >= nextFlush then nextFlush = roundTime + TR.flushInterval; flush() end
end)

pcall(function()
    Game.AddCommand("reactortrace", "Toggle the reactor trace (ReactorPowerLogger mod)", function()
        TR.enabled = not TR.enabled
        if TR.enabled then start() else stop() end
        log(TR.enabled and "on" or "off")
    end)
end)

if Game.RoundStarted then start() end
