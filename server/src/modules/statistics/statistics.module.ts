import { Module } from '@nestjs/common';

import { LibraryAccessModule } from '../library/library-access.module';
import { StatisticsController } from './statistics.controller';
import { StatisticsRepository } from './statistics.repository';
import { StatisticsService } from './statistics.service';

@Module({
  imports: [LibraryAccessModule],
  controllers: [StatisticsController],
  providers: [StatisticsService, StatisticsRepository],
})
export class StatisticsModule {}
