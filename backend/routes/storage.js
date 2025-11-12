const express = require('express');
const StorageStats = require('../models/StorageStats');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();

// Get storage overview
router.get('/overview', authMiddleware, async (req, res) => {
  try {
    let storageStats = await StorageStats.findOne({ userId: req.user._id });
    
    // If no stats exist or stats are outdated, calculate them
    if (!storageStats || Date.now() - storageStats.lastCalculated > 5 * 60 * 1000) {
      storageStats = await StorageStats.updateUserStats(req.user._id);
    }

    const maxStorage = 15 * 1024 * 1024 * 1024; // 15GB in bytes
    const usedPercentage = (storageStats.usedStorage / maxStorage) * 100;

    const overview = {
      total: {
        used: storageStats.usedStorage,
        total: maxStorage,
        percentage: usedPercentage,
        files: storageStats.totalFiles,
        folders: storageStats.totalFolders
      },
      byType: storageStats.fileTypeBreakdown,
      trends: {
        monthlyGrowth: 15, // Mock data - in real app, calculate from historical data
        yearlyGrowth: 42,
        largestFile: await getLargestFile(req.user._id),
        averageFile: storageStats.totalFiles > 0 ? storageStats.usedStorage / storageStats.totalFiles : 0
      }
    };

    res.json({
      success: true,
      overview
    });
  } catch (error) {
    console.error('Get storage overview error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while fetching storage overview'
    });
  }
});

// Get storage plans
router.get('/plans', authMiddleware, async (req, res) => {  
  try {
    const plans = [
      {
        id: 'free',
        name: 'Free',
        storage: 15 * 1024 * 1024 * 1024, // 15GB
        price: 0,
        features: [
          'Basic file storage',
          'File sharing',
          '30-day trash recovery',
          'Standard security',
          'Basic support'
        ],
        current: true
      },
      {
        id: 'pro',
        name: 'Pro',
        storage: 100 * 1024 * 1024 * 1024, // 100GB
        price: 2.99,
        features: [
          'Everything in Free',
          '100 GB storage',
          'Advanced security',
          'Priority support',
          '1-year trash recovery',
          'No ads'
        ],
        recommended: true
      },
      {
        id: 'business',
        name: 'Business',
        storage: 1024 * 1024 * 1024 * 1024, // 1TB
        price: 9.99,
        features: [
          'Everything in Pro',
          '1 TB storage',
          'Team collaboration',
          'Advanced analytics',
          '24/7 premium support',
          'Custom branding'
        ]
      }
    ];

    res.json({
      success: true,
      plans
    });
  } catch (error) {
    console.error('Get storage plans error:', error);
    res.status(500).json({
      success: false,
      error: 'Server error while fetching storage plans'
    });
  }
});

// Helper function to get largest file
async function getLargestFile(userId) {
  const File = require('../models/File');
  const largestFile = await File.findOne({ userId, inTrash: false })
    .sort({ size: -1 })
    .select('size')
    .lean();
  
  return largestFile?.size || 0;
}

module.exports = router;