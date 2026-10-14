-- Reactor Power Logger (client-side, needs Lua For Barotrauma / LuaCs with client-side Lua).
-- Every round it records, every tick (60/s), how much power the main submarine's reactor grid asks for,
-- what the main junction box reads, and the signals that predict power spikes (nav terminal, engines,
-- pumps, guns, sonar). A row is written only when something changes, plus a heartbeat every 5 s.
-- Drop the CSV into the simulator's load_profiles/ folder to replay the round.
--
-- Columns ("device.pin" columns become wireable pins in the simulator, same names as in game):
--   t                       round time (s)
--   demand                  kW the ship's devices ask for (battery charging excluded; gun supercapacitors included)
--   load, power, voltage    main junction box: load_value_out, power_value_out, power/load
--   reactor_out, turbine, fission, temp, fuel   reactor (fuel = sum of rod condition %)
--   rods                    fuel rods in the reactor right now (the simulator adds/removes rods when this changes)
--   batt_in, batt_out       kW into / out of the batteries on the reactor grid
--   nav.velocity_x_out, nav.velocity_y_out      nav terminal outputs (-100..100) -> engines / ballast pumps
--   nav.current_velocity_x, nav.current_velocity_y, nav.current_position_y      nav terminal outputs (km/h, depth m)
--   engines.load_value_out, pumps.load_value_out, guns.load_value_out, sonar.load_value_out
--                           kW drawn by each group (what a relay/junction box feeding only that group would read)
if SERVER then return end

local modPath = ...
local PL = {
    heartbeat = 5,           -- always write a row at least this often
    flushInterval = 30,      -- rewrite the file this often so a crash loses little
    kwThreshold = 2,         -- kW change that counts as "changed"
    sigThreshold = 0.5,      -- signal change that counts as "changed" (signals are -100..100)
    rescanInterval = 10,     -- re-find devices (repairs, new items)
}
local COLS = { "demand", "load", "power", "reactor_out", "turbine", "fission", "temp", "fuel", "rods", "voltage", "batt_in", "batt_out",
    "nav.velocity_x_out", "nav.velocity_y_out", "nav.current_velocity_x", "nav.current_velocity_y", "nav.current_position_y",
    "engines.load_value_out", "pumps.load_value_out", "guns.load_value_out", "sonar.load_value_out" }
local KW = { demand = true, load = true, power = true, reactor_out = true, batt_in = true, batt_out = true,
    ["engines.load_value_out"] = true, ["pumps.load_value_out"] = true, ["guns.load_value_out"] = true, ["sonar.load_value_out"] = true }

local active, rows, roundTime, lastReal, lastRowT, last, nextFlush, nextScan, filePath, header
local dev = {}

local function log(msg) print("[PowerLogger] " .. msg) end

local function logDir()
    local base = (type(modPath) == "string" and modPath ~= "") and modPath or "LocalMods/ReactorPowerLogger"
    local dir = base .. "/Logs"
    pcall(function() if not File.DirectoryExists(dir) then File.CreateDirectory(dir) end end)
    return dir
end

-- find and cache the main sub's devices (iterating every item each tick would be too slow)
local function scan()
    dev = { reactors = {}, steering = nil, engines = {}, pumps = {}, batteries = {}, supercaps = {}, turrets = {}, sonars = {} }
    local sub = Submarine.MainSub
    for item in Item.ItemList do
        if item.Submarine == sub then
            local r = item.GetComponentString("Reactor")
            if r ~= nil and item.Condition > 0 then table.insert(dev.reactors, r) end
            local st = item.GetComponentString("Steering")
            if st ~= nil and dev.steering == nil then dev.steering = st end
            local e = item.GetComponentString("Engine")
            if e ~= nil then table.insert(dev.engines, e) end
            local p = item.GetComponentString("Pump")
            if p ~= nil then table.insert(dev.pumps, p) end
            local pc = item.GetComponentString("PowerContainer")
            if pc ~= nil then
                if string.find(tostring(item.Prefab.Identifier), "supercapacitor") then table.insert(dev.supercaps, pc)
                else table.insert(dev.batteries, pc) end
            end
            local t = item.GetComponentString("Turret")
            if t ~= nil then table.insert(dev.turrets, t) end
            local so = item.GetComponentString("Sonar")
            if so ~= nil then table.insert(dev.sonars, so) end
        end
    end
end

local function sumConsumption(list)
    local s = 0
    for _, c in ipairs(list) do s = s + math.max(0, c.CurrPowerConsumption) end
    return s
end

local function powerOutConn(reactor)
    for c in reactor.Item.Connections do
        if c.IsPower and c.IsOutput then return c end
    end
    return nil
end

local function sample()
    local v = {}
    local r = dev.reactors[1]
    -- main junction box = the reactor's grid
    v.load, v.power, v.voltage = r.Load, -r.CurrPowerConsumption, 1
    pcall(function()
        local conn = powerOutConn(r)
        local grid = conn and conn.Grid
        if grid ~= nil then v.load, v.power, v.voltage = grid.Load, grid.Power, grid.Voltage end
    end)
    v.batt_in, v.batt_out = 0, 0
    for _, pc in ipairs(dev.batteries) do
        v.batt_in = v.batt_in + math.max(0, pc.CurrPowerConsumption)
        v.batt_out = v.batt_out + pc.CurrPowerOutput
    end
    v.demand = math.max(0, v.load - v.batt_in)
    v.reactor_out = 0
    for _, rr in ipairs(dev.reactors) do v.reactor_out = v.reactor_out + (-rr.CurrPowerConsumption) end
    v.turbine, v.fission, v.temp = r.TurbineOutput, r.FissionRate, r.Temperature
    v.fuel, v.rods = 0, 0
    pcall(function() for rod in r.Item.OwnInventory.AllItems do v.fuel = v.fuel + rod.ConditionPercentage; v.rods = v.rods + 1 end end)
    -- nav terminal outputs (same values the game sends on its pins)
    local st = dev.steering
    if st ~= nil then
        pcall(function()
            local tv = st.TargetVelocity
            local vx = tv.X
            if Submarine.MainSub.FlippedX then vx = -vx end
            v["nav.velocity_x_out"] = vx
            local nb = st.NeutralBallastLevel
            local sign = (tv.Y > 0 and 1) or (tv.Y < 0 and -1) or 0
            local a, b = (nb * 100 - 50) * 2, -100 * sign
            v["nav.velocity_y_out"] = a + (b - a) * (math.abs(tv.Y) / 100)
        end)
    end
    pcall(function()
        local sub = Submarine.MainSub
        v["nav.current_velocity_x"] = sub.Velocity.X * 3.6
        v["nav.current_velocity_y"] = -sub.Velocity.Y * 3.6
        v["nav.current_position_y"] = sub.RealWorldDepth
    end)
    v["engines.load_value_out"] = sumConsumption(dev.engines)
    v["pumps.load_value_out"] = sumConsumption(dev.pumps)
    v["guns.load_value_out"] = sumConsumption(dev.supercaps) + sumConsumption(dev.turrets)
    v["sonar.load_value_out"] = sumConsumption(dev.sonars)
    return v
end

local function changed(v)
    if last == nil then return true end
    for _, c in ipairs(COLS) do
        local a, b = v[c] or 0, last[c] or 0
        if math.abs(a - b) >= (KW[c] and PL.kwThreshold or PL.sigThreshold) then return true end
    end
    return false
end

local function fmt(c, n)
    if n == nil then return "" end
    if KW[c] then return string.format("%.1f", n) end
    if c == "rods" then return tostring(n) end
    return string.format("%.4f", n)
end

local function flush()
    if not active or filePath == nil then return end
    local ok, err = pcall(function() File.Write(filePath, header .. table.concat(rows, "\n") .. "\n") end)
    if not ok then log("could not write " .. tostring(filePath) .. ": " .. tostring(err)) end
end

local function startRound()
    scan()
    if #dev.reactors == 0 then log("no reactor on the main sub, not recording"); active = false; return end
    local maxKW, maxEach = 0, {}
    for _, r in ipairs(dev.reactors) do maxKW = maxKW + r.MaxPowerOutput; table.insert(maxEach, string.format("%.1f", r.MaxPowerOutput)) end
    local subName = (Submarine.MainSub and Submarine.MainSub.Info and Submarine.MainSub.Info.Name) or "unknown"
    local safe = tostring(subName):gsub("[^%w_%-]", "_")
    local dir = logDir()
    local n = 1
    while File.Exists(string.format("%s/%s_round%03d.csv", dir, safe, n)) do n = n + 1 end
    filePath = string.format("%s/%s_round%03d.csv", dir, safe, n)
    local rods, fuelType = 0, "uranium"
    local types = { fuelrod = "uranium", thoriumfuelrod = "thorium", fulguriumfuelrod = "fulgurium", fulguriumfuelrodvolatile = "volatile" }
    pcall(function()
        for rod in dev.reactors[1].Item.OwnInventory.AllItems do
            rods = rods + 1
            local t = types[tostring(rod.Prefab.Identifier)]
            if t then fuelType = t end
        end
    end)
    local battCap, battN = 0, 0
    for _, pc in ipairs(dev.batteries) do battCap = battCap + pc.Capacity; battN = battN + 1 end
    header = "# BaroPowerLog v2\n"
        .. "# sub=" .. tostring(subName) .. "\n"
        .. "# reactor_max_kw=" .. string.format("%.1f", maxKW) .. "\n"
        .. "# reactors=" .. #dev.reactors .. " (" .. table.concat(maxEach, "+") .. ")\n"
        .. "# fuel_rods=" .. rods .. "\n"
        .. "# fuel_type=" .. fuelType .. "\n"
        .. "# fuel_consumption_rate=" .. string.format("%.3f", dev.reactors[1].FuelConsumptionRate) .. "\n"
        .. "# ship_batteries=" .. battN .. " (capacity " .. string.format("%.0f", battCap) .. " kW*min)\n"
        .. "# engines=" .. #dev.engines .. " pumps=" .. #dev.pumps .. " supercapacitors=" .. #dev.supercaps .. " turrets=" .. #dev.turrets .. "\n"
        .. "t," .. table.concat(COLS, ",") .. "\n"
    rows, roundTime, lastReal, lastRowT, last, nextFlush, nextScan = {}, 0, Timer.GetTime(), -1e9, nil, PL.flushInterval, PL.rescanInterval
    active = true
    log("recording " .. tostring(subName) .. " (max " .. string.format("%.0f", maxKW) .. " kW) -> " .. filePath)
end

local function stopRound()
    if not active then return end
    table.insert(rows, "# duration=" .. string.format("%.2f", roundTime))
    flush()
    log("saved " .. #rows .. " rows to " .. tostring(filePath))
    active = false
end

Hook.Add("roundStart", "PowerLogger.roundStart", function() startRound() end)
Hook.Add("roundEnd", "PowerLogger.roundEnd", function() stopRound() end)

Hook.Add("think", "PowerLogger.think", function()
    if not active then return end
    local now = Timer.GetTime()
    local dt = now - lastReal
    lastReal = now
    if Game.Paused or dt <= 0 then return end
    roundTime = roundTime + math.min(dt, 0.1)  -- pauses / hitches don't stretch the timeline
    if roundTime >= nextScan then nextScan = roundTime + PL.rescanInterval; scan() end
    if #dev.reactors == 0 then return end

    local ok, v = pcall(sample)
    if not ok then return end
    if changed(v) or roundTime - lastRowT >= PL.heartbeat then
        local cells = { string.format("%.3f", roundTime) }
        for _, c in ipairs(COLS) do table.insert(cells, fmt(c, v[c])) end
        table.insert(rows, table.concat(cells, ","))
        last, lastRowT = v, roundTime
    end
    if roundTime >= nextFlush then nextFlush = roundTime + PL.flushInterval; flush() end
end)

-- started mid-round (e.g. "reloadlua")
if Game.RoundStarted then startRound() end
