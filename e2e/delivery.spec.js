import {test} from '@playwright/test';
import {setupDemo,deliverDemo} from './workflow.js';
test('company → measured yard → opening stock → forklift → truck → crane → reconciled site',async({page})=>{await page.goto('/');await setupDemo(page,`browser-${Date.now()}@example.test`);await deliverDemo(page);});
