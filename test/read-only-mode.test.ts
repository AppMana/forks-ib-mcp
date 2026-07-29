import { describe, it, expect, vi, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTools } from '../src/tools.js';
import { IBClient } from '../src/ib-client.js';
import { IBGatewayManager } from '../src/gateway-manager.js';

// Mock dependencies
vi.mock('../src/ib-client.js');
vi.mock('../src/gateway-manager.js');

describe('Read-Only Mode Tool Registration', () => {
    let mockMcpServer: McpServer;
    let mockIBClient: IBClient;
    let mockGatewayManager: IBGatewayManager;
    let registeredTools: string[] = [];
    let registeredDescriptions: Map<string, string>;

    beforeEach(() => {
        registeredTools = [];
        registeredDescriptions = new Map();
        mockMcpServer = {
            tool: vi.fn().mockImplementation((name, description, ...args) => {
                registeredTools.push(name);
                registeredDescriptions.set(name, description);
                return mockMcpServer;
            }),
        } as unknown as McpServer;

        mockIBClient = {} as IBClient;
        mockGatewayManager = {} as IBGatewayManager;
    });

    it('should register ALL tools when read-only mode is DISABLED (default)', () => {
        const config = {}; // No IB_READ_ONLY_MODE
        registerTools(mockMcpServer, mockIBClient, mockGatewayManager, config);

        // Verify write tools are registered
        expect(registeredTools).toContain('place_order');
        expect(registeredTools).toContain('confirm_order');
        expect(registeredTools).toContain('create_alert');
        expect(registeredTools).toContain('activate_alert');
        expect(registeredTools).toContain('delete_alert');

        // Verify read tools are also registered
        expect(registeredTools).toContain('get_positions');
        expect(registeredTools).toContain('get_market_data');
        expect(registeredTools).toContain('search_contracts');
        expect(registeredTools).toContain('get_bond_filters');
        expect(registeredTools).toContain('get_secdef_info');
    });

    it('documents the observed search ambiguities and bond issuer workflow', () => {
        registerTools(mockMcpServer, mockIBClient, mockGatewayManager, {});

        expect(registeredDescriptions.get('search_contracts')).toContain('tickers can collide');
        expect(registeredDescriptions.get('search_contracts')).toContain('literal BOND can return ETFs');
        expect(registeredDescriptions.get('search_contracts')).toContain('issuer ID');
        expect(registeredDescriptions.get('get_secdef_info')).toContain('sentinel');
    });

    it('should register ALL tools when read-only mode is EXPLICITLY FALSE', () => {
        const config = { IB_READ_ONLY_MODE: false };
        registerTools(mockMcpServer, mockIBClient, mockGatewayManager, config);

        expect(registeredTools).toContain('place_order');
        expect(registeredTools).toContain('confirm_order');
        expect(registeredTools).toContain('create_alert');
        expect(registeredTools).toContain('activate_alert');
        expect(registeredTools).toContain('delete_alert');
    });

    it('should NOT register modification tools when read-only mode is ENABLED', () => {
        const config = { IB_READ_ONLY_MODE: true };
        registerTools(mockMcpServer, mockIBClient, mockGatewayManager, config);

        // Verify write tools are NOT registered
        expect(registeredTools).not.toContain('place_order');
        expect(registeredTools).not.toContain('confirm_order');
        expect(registeredTools).not.toContain('create_alert');
        expect(registeredTools).not.toContain('activate_alert');
        expect(registeredTools).not.toContain('delete_alert');

        // Verify read tools ARE registered
        expect(registeredTools).toContain('get_positions');
        expect(registeredTools).toContain('get_market_data');
        expect(registeredTools).toContain('search_contracts');
        expect(registeredTools).toContain('get_bond_filters');
        expect(registeredTools).toContain('get_secdef_info');
        expect(registeredTools).toContain('get_account_info');
        expect(registeredTools).toContain('get_live_orders');
        expect(registeredTools).toContain('get_order_status');
        expect(registeredTools).toContain('get_alerts');
    });
});
