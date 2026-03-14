import puppeteer from 'puppeteer'
import { setTimeout } from 'node:timers/promises'

const args = ['--no-sandbox', '--disable-setuid-sandbox']
const parsedTurnstileTimeoutMs = Number.parseInt(process.env.TURNSTILE_TIMEOUT_MS ?? '30000', 10)
const turnstileTimeoutMs = Number.isFinite(parsedTurnstileTimeoutMs) ? parsedTurnstileTimeoutMs : 30000
const parsedTurnstileSolverTimeoutMs = Number.parseInt(process.env.TURNSTILE_SOLVER_TIMEOUT_MS ?? '120000', 10)
const turnstileSolverTimeoutMs = Number.isFinite(parsedTurnstileSolverTimeoutMs) ? parsedTurnstileSolverTimeoutMs : 120000
const turnstileSolverProvider = (
    process.env.TURNSTILE_SOLVER_PROVIDER
    || (process.env.CAPSOLVER_API_KEY ? 'capsolver' : '')
    || (process.env.TWOCAPTCHA_API_KEY ? '2captcha' : '')
).trim().toLowerCase()
const turnstileSolverApiKey = (
    process.env.TURNSTILE_SOLVER_API_KEY
    ?? process.env.CAPSOLVER_API_KEY
    ?? process.env.TWOCAPTCHA_API_KEY
    ?? ''
).trim()
if (process.env.PROXY_SERVER) {
    const proxy_url = new URL(process.env.PROXY_SERVER)
    proxy_url.username = ''
    proxy_url.password = ''
    args.push(`--proxy-server=${proxy_url}`.replace(/\/$/, ''))
}

async function getTurnstileState(page) {
    return page.evaluate(() => {
        const container = document.querySelector('.cf-turnstile')
        const input = document.querySelector('[name="cf-turnstile-response"], [name="cf_challenge_response"]')
        const iframe = document.querySelector('iframe[src*="challenges.cloudflare.com"]')
        const renderParams = globalThis.__turnstileRenderParams ?? {}

        return {
            url: window.location.href,
            userAgent: navigator.userAgent,
            hasContainer: Boolean(container),
            hasIframe: Boolean(iframe),
            hasInput: Boolean(input),
            tokenLength: input?.value?.length ?? 0,
            sitekey: renderParams.sitekey ?? container?.getAttribute('data-sitekey') ?? null,
            action: renderParams.action ?? container?.getAttribute('data-action') ?? null,
            cData: renderParams.cData ?? container?.getAttribute('data-cdata') ?? null,
            chlPageData: renderParams.chlPageData ?? null,
            hasCallback: Boolean(globalThis.__turnstileCallback),
        }
    })
}

async function waitForTurnstileToken(page, timeoutMs) {
    await page.waitForFunction(() => {
        const input = document.querySelector('[name="cf-turnstile-response"], [name="cf_challenge_response"]')
        return Boolean(input?.value && input.value.length > 20)
    }, { timeout: timeoutMs })

    const token = await page.evaluate(() => {
        const input = document.querySelector('[name="cf-turnstile-response"], [name="cf_challenge_response"]')
        return input?.value ?? ''
    })
    console.log('Turnstile token received', token.length)
}

async function clickTurnstileWidget(page) {
    const iframe = await page.$('iframe[src*="challenges.cloudflare.com"]')
    if (!iframe) {
        return false
    }

    await iframe.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }))
    await setTimeout(1000)
    const box = await iframe.boundingBox()
    if (!box) {
        return false
    }

    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { delay: 100 })
    return true
}

async function requestJson(url, body) {
    const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
    })
    const text = await response.text()
    let data
    try {
        data = JSON.parse(text)
    } catch {
        throw new Error(`Unexpected JSON response from ${url}: ${text.slice(0, 200)}`)
    }

    if (!response.ok) {
        throw new Error(`Request to ${url} failed with ${response.status}: ${text.slice(0, 200)}`)
    }

    return data
}

function build2CaptchaTask(state) {
    const task = {
        type: 'TurnstileTaskProxyless',
        websiteURL: state.url,
        websiteKey: state.sitekey,
    }

    if (state.action) {
        task.action = state.action
    }
    if (state.cData) {
        task.data = state.cData
    }
    if (state.chlPageData) {
        task.pagedata = state.chlPageData
    }
    if (state.userAgent) {
        task.userAgent = state.userAgent
    }

    if (!process.env.PROXY_SERVER) {
        return task
    }

    const proxy = new URL(process.env.PROXY_SERVER)
    task.type = 'TurnstileTask'
    task.proxyType = proxy.protocol.replace(':', '') === 'https' ? 'http' : proxy.protocol.replace(':', '')
    task.proxyAddress = proxy.hostname
    task.proxyPort = Number.parseInt(proxy.port || (proxy.protocol === 'https:' ? '443' : '80'), 10)
    if (proxy.username) {
        task.proxyLogin = decodeURIComponent(proxy.username)
    }
    if (proxy.password) {
        task.proxyPassword = decodeURIComponent(proxy.password)
    }
    return task
}

async function solveTurnstileWith2Captcha(state) {
    const createResult = await requestJson('https://api.2captcha.com/createTask', {
        clientKey: turnstileSolverApiKey,
        task: build2CaptchaTask(state),
    })
    if (createResult.errorId) {
        throw new Error(`2Captcha createTask failed: ${createResult.errorCode ?? createResult.errorDescription ?? createResult.errorId}`)
    }

    const deadline = Date.now() + turnstileSolverTimeoutMs
    while (Date.now() < deadline) {
        await setTimeout(5000)
        const result = await requestJson('https://api.2captcha.com/getTaskResult', {
            clientKey: turnstileSolverApiKey,
            taskId: createResult.taskId,
        })

        if (result.errorId) {
            throw new Error(`2Captcha getTaskResult failed: ${result.errorCode ?? result.errorDescription ?? result.errorId}`)
        }
        if (result.status === 'processing') {
            continue
        }
        if (result.status === 'ready' && result.solution?.token) {
            console.log('2Captcha solved Turnstile', {
                cost: result.cost,
                ip: result.ip,
                solveCount: result.solveCount,
                userAgent: result.solution.userAgent ?? null,
            })
            return result.solution.token
        }

        throw new Error(`2Captcha returned unexpected status: ${JSON.stringify(result)}`)
    }

    throw new Error(`2Captcha timed out after ${turnstileSolverTimeoutMs}ms`)
}

async function solveTurnstileWithCapsolver(state) {
    const createResult = await requestJson('https://api.capsolver.com/createTask', {
        clientKey: turnstileSolverApiKey,
        task: {
            type: 'AntiTurnstileTaskProxyLess',
            websiteURL: state.url,
            websiteKey: state.sitekey,
            metadata: {
                ...(state.action ? { action: state.action } : {}),
                ...(state.cData ? { cdata: state.cData } : {}),
            },
        },
    })
    if (createResult.errorId || !createResult.taskId) {
        throw new Error(`Capsolver createTask failed: ${createResult.errorCode ?? createResult.errorDescription ?? createResult.errorId}`)
    }

    const deadline = Date.now() + turnstileSolverTimeoutMs
    while (Date.now() < deadline) {
        await setTimeout(3000)
        const result = await requestJson('https://api.capsolver.com/getTaskResult', {
            clientKey: turnstileSolverApiKey,
            taskId: createResult.taskId,
        })

        if (result.errorId) {
            throw new Error(`Capsolver getTaskResult failed: ${result.errorCode ?? result.errorDescription ?? result.errorId}`)
        }
        if (result.status === 'processing' || result.status === 'idle') {
            continue
        }
        if (result.status === 'ready' && result.solution?.token) {
            console.log('Capsolver solved Turnstile')
            return result.solution.token
        }

        throw new Error(`Capsolver returned unexpected status: ${JSON.stringify(result)}`)
    }

    throw new Error(`Capsolver timed out after ${turnstileSolverTimeoutMs}ms`)
}

async function solveTurnstile(page) {
    const state = await getTurnstileState(page)
    if (!state.sitekey) {
        throw new Error(`Turnstile sitekey was not found: ${JSON.stringify(state)}`)
    }
    if (!turnstileSolverApiKey) {
        throw new Error('TURNSTILE_SOLVER_API_KEY is not set')
    }

    switch (turnstileSolverProvider || '2captcha') {
        case '2captcha':
            return solveTurnstileWith2Captcha(state)
        case 'capsolver':
            return solveTurnstileWithCapsolver(state)
        default:
            throw new Error(`Unsupported TURNSTILE_SOLVER_PROVIDER: ${turnstileSolverProvider}`)
    }
}

async function applyTurnstileToken(page, token) {
    await page.evaluate((value) => {
        const setFieldValue = (selector, name) => {
            let field = document.querySelector(selector)
            if (!field) {
                field = document.createElement('input')
                field.type = 'hidden'
                field.name = name
                ;(document.querySelector('form') ?? document.body).appendChild(field)
            }
            field.value = value
            field.dispatchEvent(new Event('input', { bubbles: true }))
            field.dispatchEvent(new Event('change', { bubbles: true }))
        }

        setFieldValue('[name="cf-turnstile-response"]', 'cf-turnstile-response')
        setFieldValue('[name="g-recaptcha-response"]', 'g-recaptcha-response')

        if (typeof globalThis.__turnstileCallback === 'function') {
            globalThis.__turnstileCallback(value)
        }
    }, token)
}

async function ensureTurnstileReady(page) {
    const state = await getTurnstileState(page)
    if (!state.hasContainer && !state.hasIframe && !state.hasInput) {
        console.log('Turnstile widget not found')
        return
    }
    if (state.tokenLength > 20) {
        console.log('Turnstile token already present', state.tokenLength)
        return
    }

    console.log('Waiting for Turnstile token', state)
    const firstWaitMs = Math.min(turnstileTimeoutMs, 5000)
    try {
        await waitForTurnstileToken(page, firstWaitMs)
        return
    } catch (error) {
        console.log('Turnstile token was not generated automatically', error.message)
    }

    if (await clickTurnstileWidget(page)) {
        console.log('Clicked Turnstile widget, waiting for token again')
    } else {
        console.log('Turnstile widget click was not available')
    }

    try {
        await waitForTurnstileToken(page, turnstileTimeoutMs)
    } catch (error) {
        console.log('Turnstile token was still unavailable', await getTurnstileState(page))
        const token = await solveTurnstile(page)
        await applyTurnstileToken(page, token)
        console.log('Injected Turnstile token from solver')
    }
}

const browser = await puppeteer.launch({
    defaultViewport: { width: 1080, height: 1024 },
    args,
})
const [page] = await browser.pages()
const userAgent = await browser.userAgent()
await page.setUserAgent(userAgent.replace('Headless', ''))
await page.setExtraHTTPHeaders({ 'accept-language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7' })
await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    Object.defineProperty(navigator, 'language', { get: () => 'ja-JP' })
    Object.defineProperty(navigator, 'languages', { get: () => ['ja-JP', 'ja', 'en-US', 'en'] })
    Object.defineProperty(navigator, 'platform', { get: () => 'Win32' })

    const installTurnstileHook = () => {
        if (!globalThis.turnstile || typeof globalThis.turnstile.render !== 'function' || globalThis.turnstile.__codexHookInstalled) {
            return false
        }

        const originalRender = globalThis.turnstile.render.bind(globalThis.turnstile)
        globalThis.turnstile.render = (container, params = {}) => {
            globalThis.__turnstileRenderParams = {
                sitekey: params.sitekey ?? null,
                action: params.action ?? null,
                cData: params.cData ?? params.cdata ?? null,
                chlPageData: params.chlPageData ?? null,
            }
            if (typeof params.callback === 'function') {
                globalThis.__turnstileCallback = params.callback
            }
            return originalRender(container, params)
        }
        globalThis.turnstile.__codexHookInstalled = true
        return true
    }

    installTurnstileHook()
    const hookTimer = setInterval(() => {
        if (installTurnstileHook()) {
            clearInterval(hookTimer)
        }
    }, 50)
})
const recorder = await page.screencast({ path: 'recording.webm' })

try {
    if (process.env.PROXY_SERVER) {
        const { username, password } = new URL(process.env.PROXY_SERVER)
        if (username && password) {
            await page.authenticate({ username, password })
        }
    }

    await page.goto('https://secure.xserver.ne.jp/xapanel/login/xvps/', { waitUntil: 'networkidle2' })
    await page.locator('#memberid').fill(process.env.EMAIL)
    await page.locator('#user_password').fill(process.env.PASSWORD)
    await page.locator('text=ログインする').click()
    await page.waitForNavigation({ waitUntil: 'networkidle2' })
    await page.locator('a[href^="/xapanel/xvps/server/detail?id="]').click()
    await page.locator('text=更新する').click()
    await page.locator('text=引き続き無料VPSの利用を継続する').click()
    await page.waitForNavigation({ waitUntil: 'networkidle2' })
    const body = await page.$eval('img[src^="data:"]', img => img.src)
    const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', { method: 'POST', body }).then(r => r.text())
    await page.locator('[placeholder="上の画像の数字を入力"]').fill(code)
    await ensureTurnstileReady(page)
    await page.locator('text=無料VPSの利用を継続する').click()
} catch (e) {
    console.error(e)
} finally {
    await setTimeout(5000)
    await recorder.stop()
    await browser.close()
}
