import puppeteer from 'puppeteer'
import { writeFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'

const loginUrl = 'https://secure.xserver.ne.jp/xapanel/login/xvps/'
const continueButtonText = '無料VPSの利用を継続する'
const loginButtonText = 'ログインする'
const captchaImageSelector = 'img[src^="data:image"], img[src^="data:"]'
const captchaInputSelector = '[placeholder*="上の画像"]'
const turnstileInputSelector = '[name="cf-turnstile-response"], [name="cf_challenge_response"]'
const parsedTurnstileTimeoutMs = Number.parseInt(process.env.TURNSTILE_TIMEOUT_MS ?? '30000', 10)
const turnstileTimeoutMs = Number.isFinite(parsedTurnstileTimeoutMs) ? parsedTurnstileTimeoutMs : 30000
const parsedTurnstileSolverTimeoutMs = Number.parseInt(process.env.TURNSTILE_SOLVER_TIMEOUT_MS ?? '120000', 10)
const turnstileSolverTimeoutMs = Number.isFinite(parsedTurnstileSolverTimeoutMs) ? parsedTurnstileSolverTimeoutMs : 120000
const turnstileSolverProvider = (process.env.TURNSTILE_SOLVER_PROVIDER || '2captcha').trim().toLowerCase()
const turnstileSolverApiKey = (
    process.env.TURNSTILE_SOLVER_API_KEY
    ?? process.env.TWOCAPTCHA_API_KEY
    ?? ''
).trim()

const args = ['--no-sandbox', '--disable-setuid-sandbox']
if (process.env.PROXY_SERVER) {
    const proxyUrl = new URL(process.env.PROXY_SERVER)
    proxyUrl.username = ''
    proxyUrl.password = ''
    args.push(`--proxy-server=${proxyUrl}`.replace(/\/$/, ''))
}

async function saveDebugArtifacts(page, prefix) {
    const safePrefix = prefix.replace(/[^a-z0-9-_]/gi, '-').toLowerCase()
    await page.screenshot({ path: `debug-${safePrefix}.png`, fullPage: true }).catch(() => {})
    const html = await page.content().catch(() => '')
    if (html) {
        await writeFile(`debug-${safePrefix}.html`, html)
    }
}

async function getTurnstileState(page) {
    return page.evaluate((selector) => {
        const container = document.querySelector('.cf-turnstile')
        const input = document.querySelector(selector)
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
            cData: renderParams.cData ?? renderParams.cdata ?? container?.getAttribute('data-cdata') ?? null,
            chlPageData: renderParams.chlPageData ?? null,
            hasCallback: Boolean(globalThis.__turnstileCallback),
        }
    }, turnstileInputSelector)
}

async function getRenewalPageState(page) {
    return page.evaluate(({ imageSelector, inputSelector, turnstileSelector, submitText }) => {
        const input = document.querySelector(inputSelector)
        const directImage = document.querySelector(imageSelector)
        const relatedImage = input
            ?.closest('form, table, section, article, div')
            ?.querySelector('img')
        const image = directImage ?? relatedImage ?? null
        const submitNode = Array.from(document.querySelectorAll('a, button, input[type="submit"], input[type="button"]'))
            .find(node => (node.textContent ?? node.value ?? '').includes(submitText))

        return {
            url: window.location.href,
            title: document.title,
            hasCaptchaImage: Boolean(image?.src),
            captchaImageSourceKind: image?.src?.startsWith('data:') ? 'data-url' : (image?.src ? 'url' : null),
            hasCaptchaInput: Boolean(input),
            hasTurnstile: Boolean(
                document.querySelector('.cf-turnstile')
                || document.querySelector('iframe[src*="challenges.cloudflare.com"]')
                || document.querySelector(turnstileSelector)
            ),
            hasContinueButton: Boolean(submitNode),
            bodySnippet: document.body?.innerText?.replace(/\s+/g, ' ').slice(0, 300) ?? '',
        }
    }, {
        imageSelector: captchaImageSelector,
        inputSelector: captchaInputSelector,
        turnstileSelector: turnstileInputSelector,
        submitText: continueButtonText,
    })
}

async function waitForTurnstileToken(page, timeoutMs) {
    await page.waitForFunction((selector) => {
        const input = document.querySelector(selector)
        return Boolean(input?.value && input.value.length > 20)
    }, { timeout: timeoutMs }, turnstileInputSelector)

    const token = await page.evaluate((selector) => document.querySelector(selector)?.value ?? '', turnstileInputSelector)
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

async function solveTurnstile(page) {
    if (turnstileSolverProvider !== '2captcha') {
        throw new Error(`Unsupported TURNSTILE_SOLVER_PROVIDER: ${turnstileSolverProvider}`)
    }
    if (!turnstileSolverApiKey) {
        throw new Error('TURNSTILE_SOLVER_API_KEY is not set')
    }

    const state = await getTurnstileState(page)
    if (!state.sitekey) {
        throw new Error(`Turnstile sitekey was not found: ${JSON.stringify(state)}`)
    }

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
    } catch {
        console.log('Turnstile token was still unavailable', await getTurnstileState(page))
        const token = await solveTurnstile(page)
        await applyTurnstileToken(page, token)
        console.log('Injected Turnstile token from solver')
    }
}

async function waitForPotentialPageChange(page, previousUrl) {
    try {
        await page.waitForFunction((url, imageSelector, inputSelector, turnstileSelector) => {
            return (
                window.location.href !== url
                || Boolean(document.querySelector(imageSelector))
                || Boolean(document.querySelector(inputSelector))
                || Boolean(document.querySelector('.cf-turnstile'))
                || Boolean(document.querySelector('iframe[src*="challenges.cloudflare.com"]'))
                || Boolean(document.querySelector(turnstileSelector))
            )
        }, { timeout: 10000 }, previousUrl, captchaImageSelector, captchaInputSelector, turnstileInputSelector)
    } catch {
        // Let the next state check decide whether we progressed.
    }
}

async function clickContinueButton(page, reason) {
    console.log('Clicking continue button', reason)
    await page.locator(`text=${continueButtonText}`).click()
}

async function getCaptchaImageBody(page) {
    return page.evaluate(async ({ imageSelector, inputSelector }) => {
        const findImage = () => {
            const directImage = document.querySelector(imageSelector)
            if (directImage?.src) {
                return directImage
            }

            const input = document.querySelector(inputSelector)
            if (!input) {
                return null
            }

            const container = input.closest('form, table, section, article, div') ?? document
            return container.querySelector('img')
        }

        const image = findImage()
        if (!image?.src) {
            return null
        }
        if (image.src.startsWith('data:')) {
            return image.src
        }

        const response = await fetch(image.src, { credentials: 'include' })
        if (!response.ok) {
            throw new Error(`Failed to fetch CAPTCHA image: ${response.status}`)
        }

        const blob = await response.blob()
        return new Promise((resolve, reject) => {
            const reader = new FileReader()
            reader.onerror = () => reject(new Error('Failed to convert CAPTCHA image to data URL'))
            reader.onloadend = () => resolve(reader.result)
            reader.readAsDataURL(blob)
        })
    }, {
        imageSelector: captchaImageSelector,
        inputSelector: captchaInputSelector,
    })
}

async function waitForRenewalCaptcha(page) {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const state = await getRenewalPageState(page)
        console.log('Renewal page state', { attempt, ...state })

        if (state.hasCaptchaImage && state.hasCaptchaInput) {
            return
        }

        if (state.hasTurnstile) {
            await ensureTurnstileReady(page)
            if (!state.hasCaptchaImage && state.hasContinueButton) {
                const previousUrl = page.url()
                await clickContinueButton(page, 'advance after Turnstile')
                await waitForPotentialPageChange(page, previousUrl)
                continue
            }
        }

        if (state.hasContinueButton && !state.hasCaptchaImage) {
            const previousUrl = page.url()
            await clickContinueButton(page, 'retry until CAPTCHA image is visible')
            await waitForPotentialPageChange(page, previousUrl)
            continue
        }

        await setTimeout(3000)
    }

    await saveDebugArtifacts(page, 'renewal-page-missing-captcha')
    throw new Error(`Verification page did not expose the CAPTCHA image: ${JSON.stringify(await getRenewalPageState(page))}`)
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

    await page.goto(loginUrl, { waitUntil: 'networkidle2' })
    await page.locator('#memberid').fill(process.env.EMAIL)
    await page.locator('#user_password').fill(process.env.PASSWORD)
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.locator(`text=${loginButtonText}`).click(),
    ])
    await page.locator('a[href^="/xapanel/xvps/server/detail?id="]').click()
    await page.locator('text=更新する').click()
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {}),
        page.locator(`text=${continueButtonText}`).click(),
    ])

    await waitForRenewalCaptcha(page)

    const body = await getCaptchaImageBody(page)
    if (!body) {
        await saveDebugArtifacts(page, 'captcha-image-missing')
        throw new Error(`Captcha image is still missing after waiting: ${JSON.stringify(await getRenewalPageState(page))}`)
    }

    const code = await fetch('https://captcha-120546510085.asia-northeast1.run.app', {
        method: 'POST',
        body,
        headers: { 'content-type': 'text/plain' },
    }).then(response => response.text())

    await page.locator(captchaInputSelector).fill(code.trim())
    await ensureTurnstileReady(page)
    await clickContinueButton(page, 'submit renewal form')
} catch (error) {
    await saveDebugArtifacts(page, 'main-error')
    console.error(error)
    process.exitCode = 1
} finally {
    await setTimeout(5000)
    await recorder.stop()
    await browser.close()
}
