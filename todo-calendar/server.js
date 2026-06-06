'use strict'
require('dotenv').config()

const express = require('express')
const cors = require('cors')
const fs = require('fs')
const path = require('path')
const { google } = require('googleapis')

const app = express()
const PORT = process.env.PORT || 3456
const STATE_FILE = path.join(__dirname, '.sync-state.json')

app.use(cors())
app.use(express.json())
app.use(express.static(__dirname))

// ── Persistent state ───────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) }
  catch { return {} }
}
function saveState(patch) {
  const s = loadState()
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...s, ...patch }, null, 2))
}

// ── Status ─────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const s = loadState()
  res.json({
    google: { connected: !!(s.googleTokens && process.env.GOOGLE_CLIENT_ID) },
    caldav: {
      connected: !!(s.caldavUser && s.caldavPass && s.caldavCalUrl),
      user: s.caldavUser || null,
      calUrl: s.caldavCalUrl || null
    }
  })
})

// ── Google Calendar ────────────────────────────────────────────────
function makeOAuth2() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    `http://localhost:${PORT}/api/google/callback`
  )
}

async function getAuthClient() {
  const s = loadState()
  if (!s.googleTokens) throw new Error('Google not connected')
  const auth = makeOAuth2()
  auth.setCredentials(s.googleTokens)
  auth.on('tokens', tokens => {
    if (tokens.access_token) saveState({ googleTokens: { ...loadState().googleTokens, ...tokens } })
  })
  return auth
}

app.get('/api/google/auth-url', (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return res.status(400).json({ error: '未配置 GOOGLE_CLIENT_ID，请先编辑 .env 文件' })
  }
  const url = makeOAuth2().generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    prompt: 'consent'
  })
  res.json({ url })
})

app.get('/api/google/callback', async (req, res) => {
  try {
    const auth = makeOAuth2()
    const { tokens } = await auth.getToken(req.query.code)
    saveState({ googleTokens: tokens })
    res.send(`<!DOCTYPE html><html><body style="font-family:-apple-system,sans-serif;text-align:center;padding:60px;color:#1e293b">
      <div style="font-size:52px;margin-bottom:16px">✅</div>
      <h2 style="font-weight:700">Google Calendar 已连接</h2>
      <p style="color:#64748b;margin-top:8px">可以关闭此窗口</p>
      <script>window.opener&&window.opener.postMessage('google-connected','*');setTimeout(()=>window.close(),1500)</script>
    </body></html>`)
  } catch (e) {
    res.status(400).send('连接失败: ' + e.message)
  }
})

// Upsert a single todo as a Google Calendar event
app.post('/api/google/event', async (req, res) => {
  try {
    const auth = await getAuthClient()
    const cal = google.calendar({ version: 'v3', auth })
    const { date, todo } = req.body
    const colors = { P0: '11', P1: '6', P2: '1' }
    const startEnd = todo.time
      ? { start: { dateTime: `${date}T${todo.time}:00+08:00` },
          end:   { dateTime: `${date}T${addOneHour(todo.time)}:00+08:00` } }
      : { start: { date }, end: { date } }
    const body = {
      summary: `[${todo.priority}] ${todo.content}`,
      ...startEnd,
      colorId: colors[todo.priority] || '1',
      extendedProperties: {
        private: { _todoId: todo.id, _todoPriority: todo.priority, _todoDone: String(todo.done) }
      }
    }
    let event
    if (todo.gcalId) {
      try {
        event = await cal.events.update({ calendarId: 'primary', eventId: todo.gcalId, requestBody: body })
      } catch (e) {
        if (e.code === 404 || e.code === 410) {
          event = await cal.events.insert({ calendarId: 'primary', requestBody: body })
        } else throw e
      }
    } else {
      event = await cal.events.insert({ calendarId: 'primary', requestBody: body })
    }
    res.json({ gcalId: event.data.id })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.delete('/api/google/event/:id', async (req, res) => {
  try {
    const auth = await getAuthClient()
    const cal = google.calendar({ version: 'v3', auth })
    await cal.events.delete({ calendarId: 'primary', eventId: req.params.id })
    res.json({ ok: true })
  } catch (e) {
    if (e.code === 404 || e.code === 410) return res.json({ ok: true })
    res.status(500).json({ error: e.message })
  }
})

// Pull our todo events from Google Calendar (identified by _todoId extended prop)
app.get('/api/google/events', async (req, res) => {
  try {
    const auth = await getAuthClient()
    const cal = google.calendar({ version: 'v3', auth })
    const { year, month } = req.query
    const timeMin = new Date(+year, +month - 1, 1).toISOString()
    const timeMax = new Date(+year, +month, 0, 23, 59, 59).toISOString()
    const r = await cal.events.list({
      calendarId: 'primary',
      timeMin, timeMax,
      singleEvents: true,
      privateExtendedProperty: ['_todoId']
    })
    res.json({
      events: (r.data.items || []).map(e => {
        const dt = e.start?.dateTime
        return {
          gcalId: e.id,
          summary: e.summary || '',
          date: e.start?.date || (dt ? dt.slice(0, 10) : undefined),
          time: dt ? dt.slice(11, 16) : null,
          props: e.extendedProperties?.private || {}
        }
      })
    })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── iCloud CalDAV ──────────────────────────────────────────────────
function addOneHour(hhmm) {
  const [h, m] = hhmm.split(':').map(Number)
  return `${String(Math.min(h + 1, 23)).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function makeICS(date, todo, icalId) {
  const dt = date.replace(/-/g, '')
  const pMap = { P0: 1, P1: 5, P2: 9 }
  const summary = todo.content.replace(/[\\;,]/g, c => '\\' + c).replace(/\n/g, '\\n')
  let dtstart, dtend
  if (todo.time) {
    const [hh, mm] = todo.time.split(':')
    const endTime = addOneHour(todo.time).replace(':', '')
    dtstart = `DTSTART;TZID=Asia/Shanghai:${dt}T${hh}${mm}00`
    dtend   = `DTEND;TZID=Asia/Shanghai:${dt}T${endTime}00`
  } else {
    const d = new Date(date)
    d.setDate(d.getDate() + 1)
    const dtNext = d.toISOString().slice(0, 10).replace(/-/g, '')
    dtstart = `DTSTART;VALUE=DATE:${dt}`
    dtend   = `DTEND;VALUE=DATE:${dtNext}`
  }
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Todo-Calendar//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    'UID:' + icalId,
    dtstart, dtend,
    'SUMMARY:[' + todo.priority + '] ' + summary,
    'STATUS:' + (todo.done ? 'COMPLETED' : 'CONFIRMED'),
    'PRIORITY:' + (pMap[todo.priority] || 9),
    'X-TODO-ID:' + todo.id,
    'END:VEVENT', 'END:VCALENDAR'
  ].join('\r\n')
}

function parseICS(str) {
  const r = {}
  let inVEvent = false
  ;(str || '').replace(/\r\n[ \t]/g, '').split(/\r\n|\n/).forEach(line => {
    const t = line.trim()
    if (t === 'BEGIN:VEVENT') { inVEvent = true; return }
    if (t === 'END:VEVENT') { inVEvent = false; return }
    if (!inVEvent) return
    const m = line.match(/^([^:]+):(.*)$/)
    if (!m) return
    const key = m[1].trim(), val = m[2].trim()
    r[key] = val
    // Also index by base name so DTSTART;TZID=... is accessible as DTSTART
    const base = key.split(';')[0]
    if (base !== key && !r[base]) r[base] = val
  })
  return r
}

// Connect iCloud via CalDAV (uses tsdav for discovery)
// password is optional: if omitted, reuse the previously saved password
app.post('/api/caldav/connect', async (req, res) => {
  const s = loadState()
  const username = req.body.username
  const password = req.body.password || s.caldavPass  // reuse saved if not provided
  if (!username || !password) return res.status(400).json({ error: '请提供 Apple ID 和应用专用密码' })
  try {
    const { createDAVClient } = require('tsdav')
    const client = await createDAVClient({
      serverUrl: 'https://caldav.icloud.com',
      credentials: { username, password },
      authMethod: 'Basic',
      defaultAccountType: 'caldav'
    })
    const cals = await client.fetchCalendars()
    if (!cals.length) throw new Error('未找到任何日历')
    // Prefer "日历" (Home) > any non-reminders > first
    const defCal =
      cals.find(c => c.displayName === '日历' || c.displayName === 'Calendar') ||
      cals.find(c => !/remind/i.test(c.url + (c.displayName || '')) && !/task/i.test(c.url)) ||
      cals[0]
    const calUrl = defCal.url.endsWith('/') ? defCal.url : defCal.url + '/'
    saveState({
      caldavUser: username,
      caldavPass: password,
      caldavCalUrl: calUrl,
      caldavCals: cals.map(c => ({ url: c.url, name: c.displayName || c.url }))
    })
    res.json({ ok: true, calendars: cals.map(c => ({ url: c.url, name: c.displayName || c.url })) })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Debug: show raw event count + samples from current calendar
app.get('/api/caldav/test-events', async (req, res) => {
  const s = loadState()
  if (!s.caldavUser) return res.status(401).json({ error: 'not connected' })
  try {
    const { createDAVClient } = require('tsdav')
    const client = await createDAVClient({
      serverUrl: 'https://caldav.icloud.com',
      credentials: { username: s.caldavUser, password: s.caldavPass },
      authMethod: 'Basic',
      defaultAccountType: 'caldav'
    })
    const cals = await client.fetchCalendars()
    const cal = cals.find(c => c.url === s.caldavCalUrl || c.url + '/' === s.caldavCalUrl) || cals[0]
    const objects = await client.fetchCalendarObjects({ calendar: cal })
    const samples = objects.slice(0, 5).map(o => {
      const p = parseICS(o.data)
      return { summary: p['SUMMARY'], date: p['DTSTART;VALUE=DATE'] || p['DTSTART'], uid: p['UID'] }
    })
    res.json({ calName: cal.displayName, calUrl: cal.url, total: objects.length, samples })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Upsert a todo as a CalDAV VEVENT via raw PUT (avoids etag dance)
app.post('/api/caldav/event', async (req, res) => {
  const s = loadState()
  if (!s.caldavCalUrl) return res.status(401).json({ error: 'iCloud not connected' })
  try {
    const { date, todo } = req.body
    const icalId = todo.icalId || ('todo-' + todo.id)
    const icsData = makeICS(date, todo, icalId)
    const url = s.caldavCalUrl + icalId + '.ics'
    const auth = 'Basic ' + Buffer.from(s.caldavUser + ':' + s.caldavPass).toString('base64')
    const r = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Authorization': auth },
      body: icsData
    })
    if (!r.ok && r.status !== 201 && r.status !== 204 && r.status !== 207) {
      throw new Error(`CalDAV PUT failed ${r.status}`)
    }
    res.json({ icalId })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.delete('/api/caldav/event/:icalId', async (req, res) => {
  const s = loadState()
  if (!s.caldavCalUrl) return res.status(401).json({ error: 'iCloud not connected' })
  try {
    const url = s.caldavCalUrl + req.params.icalId + '.ics'
    const auth = 'Basic ' + Buffer.from(s.caldavUser + ':' + s.caldavPass).toString('base64')
    await fetch(url, { method: 'DELETE', headers: { 'Authorization': auth } })
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// List available calendars (for UI picker)
app.get('/api/caldav/calendars', async (req, res) => {
  const s = loadState()
  if (!s.caldavUser) return res.status(401).json({ error: 'iCloud not connected' })
  try {
    const { createDAVClient } = require('tsdav')
    const client = await createDAVClient({
      serverUrl: 'https://caldav.icloud.com',
      credentials: { username: s.caldavUser, password: s.caldavPass },
      authMethod: 'Basic',
      defaultAccountType: 'caldav'
    })
    const cals = await client.fetchCalendars()
    res.json({ calendars: cals.map(c => ({ url: c.url, name: c.displayName || c.url, active: c.url === s.caldavCalUrl || c.url + '/' === s.caldavCalUrl })) })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Switch active calendar
app.post('/api/caldav/set-calendar', (req, res) => {
  const { url } = req.body
  const calUrl = url.endsWith('/') ? url : url + '/'
  saveState({ caldavCalUrl: calUrl })
  res.json({ ok: true })
})

// Pull ALL events from iCloud for a month (not just ones created by this app)
app.get('/api/caldav/events', async (req, res) => {
  const s = loadState()
  if (!s.caldavCalUrl) return res.status(401).json({ error: 'iCloud not connected' })
  try {
    const { createDAVClient } = require('tsdav')
    const client = await createDAVClient({
      serverUrl: 'https://caldav.icloud.com',
      credentials: { username: s.caldavUser, password: s.caldavPass },
      authMethod: 'Basic',
      defaultAccountType: 'caldav'
    })
    const cals = await client.fetchCalendars()
    const cal = cals.find(c => c.url === s.caldavCalUrl || c.url + '/' === s.caldavCalUrl) || cals[0]
    const { year, month } = req.query

    // Fetch from ALL non-reminders calendars and merge
    const syncCals = cals.filter(c => {
      const name = (c.displayName || '').toLowerCase()
      const url = (c.url || '').toLowerCase()
      return !name.includes('提醒') && !name.includes('remind') && !url.includes('remind')
    })
    const chunks = await Promise.all(syncCals.map(c => client.fetchCalendarObjects({ calendar: c })))
    const objects = chunks.flat()

    const prefix = `${String(year).padStart(4,'0')}-${String(month).padStart(2,'0')}`
    const events = objects.map(o => {
      const p = parseICS(o.data)
      const rawDT = p['DTSTART'] || ''
      const rawDate = rawDT.slice(0, 8)
      const date = rawDate.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')
      const timeMatch = rawDT.match(/T(\d{2})(\d{2})/)
      const time = timeMatch ? `${timeMatch[1]}:${timeMatch[2]}` : null
      return {
        icalId: p['UID'],
        date,
        time,
        summary: (p['SUMMARY'] || '').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\n/g, ' '),
        todoId: p['X-TODO-ID'] || null,
        done: p['STATUS'] === 'COMPLETED',
        priority: p['PRIORITY'] || ''
      }
    }).filter(e => e.date.startsWith(prefix) && e.summary)

    res.json({ events, total: objects.length, calName: cal.displayName || cal.url })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

app.listen(PORT, () => {
  console.log(`\n✅  Todo Calendar Sync Server`)
  console.log(`    http://localhost:${PORT}/todo-calendar.html\n`)
  if (!process.env.GOOGLE_CLIENT_ID) {
    console.log('⚠️  GOOGLE_CLIENT_ID not set — copy .env.example → .env and fill in credentials\n')
  }
})
